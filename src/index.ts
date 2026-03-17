import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';
import { createHash } from './hash';

const API_URL = 'https://abtest.rivium.co';
const STORAGE_PREFIX = 'rivium_ab_testing_';

// ============================================
// TYPES & INTERFACES
// ============================================

export interface RiviumAbTestingConfig {
  /** API key for authentication (format: rv_live_xxx or rv_test_xxx) */
  apiKey: string;
  debug?: boolean;
  flushInterval?: number;
  maxQueueSize?: number;
  autoTrack?: boolean;
}

export interface Experiment {
  id: string;
  key: string;
  name: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'archived';
  trafficAllocation: number;
  variants: Variant[];
  targetingRules?: Record<string, any>;
}

export interface Variant {
  id: string;
  key: string;
  name: string;
  trafficSplit: number;
  isControl: boolean;
  config?: Record<string, any>;
}

export interface Assignment {
  experimentId: string;
  experimentKey: string;
  variantId: string;
  variantKey: string;
  isControl: boolean;
  config?: Record<string, any>;
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  rolloutPercentage: number;
  targetingRules?: Record<string, any>;
  variants?: FlagVariant[];
  defaultValue?: any;
}

export interface FlagVariant {
  key: string;
  value?: any;
  weight: number;
}

export enum EventType {
  // Core events
  VIEW = 'view',
  CLICK = 'click',
  CONVERSION = 'conversion',
  CUSTOM = 'custom',
  // Engagement events
  SCROLL = 'scroll',
  FORM_SUBMIT = 'form_submit',
  SEARCH = 'search',
  SHARE = 'share',
  // E-commerce events
  ADD_TO_CART = 'add_to_cart',
  REMOVE_FROM_CART = 'remove_from_cart',
  BEGIN_CHECKOUT = 'begin_checkout',
  PURCHASE = 'purchase',
  // Media events
  VIDEO_START = 'video_start',
  VIDEO_COMPLETE = 'video_complete',
  // User events
  SIGN_UP = 'sign_up',
  LOGIN = 'login',
  LOGOUT = 'logout',
}

export type RiviumAbTestingEventType =
  | 'initialized'
  | 'error'
  | 'experimentAssigned'
  | 'experimentsRefreshed'
  | 'featureFlagsRefreshed'
  | 'syncCompleted'
  | 'offlineMode'
  | 'onlineMode';

export interface RiviumAbTestingEvent {
  type: RiviumAbTestingEventType;
  data?: any;
}

type EventCallback = (event: RiviumAbTestingEvent) => void;

// ============================================
// INTERNAL TYPES
// ============================================

interface OfflineEvent {
  id: string;
  experimentId: string;
  variantId: string;
  userId: string;
  eventType: string;
  eventName: string;
  eventValue?: number;
  metadata?: Record<string, any>;
  timestamp: string;
  retryCount: number;
}

interface CachedAssignment {
  experimentId: string;
  variantId: string;
  variantName: string;
  assignedAt: string;
}

interface CachedExperiment {
  id: string;
  name: string;
  trafficAllocation: number;
  variants: {
    id: string;
    name: string;
    config?: Record<string, any>;
    isControl: boolean;
    trafficSplit: number;
  }[];
  cachedAt: string;
}

interface SyncConfig {
  syncIntervalSeconds: number;
  maxBatchSize: number;
  maxOfflineEvents: number;
  maxRetries: number;
}

// ============================================
// SDK IMPLEMENTATION
// ============================================

class RiviumAbTestingSDK {
  private listeners: Map<string, EventCallback[]> = new Map();
  private isInitialized = false;
  private config: RiviumAbTestingConfig | null = null;

  // State
  private userId: string | null = null;
  private userAttributes: Record<string, any> = {};
  private cachedExperiments: CachedExperiment[] = [];
  private eventQueue: OfflineEvent[] = [];

  // Sync
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;
  private syncConfig: SyncConfig = {
    syncIntervalSeconds: 30,
    maxBatchSize: 100,
    maxOfflineEvents: 1000,
    maxRetries: 3,
  };

  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

  // ============================================
  // INITIALIZATION
  // ============================================

  async init(config: RiviumAbTestingConfig): Promise<void> {
    if (this.isInitialized) return;

    this.config = config;

    // Load persisted state
    await this.loadPersistedState();

    // Start sync timer
    const interval = config.flushInterval || 30000;
    this.syncConfig.syncIntervalSeconds = Math.floor(interval / 1000);
    this.startSyncTimer();

    // Listen for app state changes to flush on background
    this.appStateSubscription = AppState.addEventListener(
      'change',
      this.onAppStateChange
    );

    this.isInitialized = true;

    // Fetch fresh experiments
    this.fetchExperiments().catch(() => {});

    this.emit('initialized', { offline: false });
  }

  // ============================================
  // USER MANAGEMENT
  // ============================================

  async setUserId(userId: string): Promise<void> {
    this.ensureInitialized();
    this.userId = userId;
    await AsyncStorage.setItem(`${STORAGE_PREFIX}user_id`, userId);
  }

  async getUserId(): Promise<string | null> {
    this.ensureInitialized();
    return this.userId;
  }

  async setUserAttributes(attributes: Record<string, any>): Promise<void> {
    this.ensureInitialized();
    this.userAttributes = { ...this.userAttributes, ...attributes };
  }

  // ============================================
  // EXPERIMENT ASSIGNMENT
  // ============================================

  async getVariant(
    experimentKey: string,
    defaultVariant: string = 'control'
  ): Promise<string> {
    this.ensureInitialized();
    this.ensureUserId();

    // Check cached assignment (sticky bucketing)
    const cachedAssignment = await this.getCachedAssignment(experimentKey);
    if (cachedAssignment) {
      return cachedAssignment.variantName;
    }

    // Try server assignment
    try {
      const response = await fetch(`${API_URL}/public/assign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config!.apiKey,
        },
        body: JSON.stringify({
          experimentId: experimentKey,
          userId: this.userId,
          context: this.userAttributes,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const variantName = data.variantName as string;

        // Cache assignment
        await this.cacheAssignment({
          experimentId: experimentKey,
          variantId: data.variantId,
          variantName,
          assignedAt: new Date().toISOString(),
        });

        this.emit('experimentAssigned', {
          experimentKey,
          variantKey: variantName,
          config: data.config,
        });

        return variantName;
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to get assignment from server:', e);
      }
    }

    // Offline fallback: local bucketing
    return this.getLocalAssignment(experimentKey, defaultVariant);
  }

  async getVariantConfig(
    experimentKey: string
  ): Promise<Record<string, any> | null> {
    this.ensureInitialized();

    try {
      const response = await fetch(
        `${API_URL}/public/variant-config?experimentId=${experimentKey}&userId=${this.userId}`,
        {
          headers: { 'x-api-key': this.config!.apiKey },
        }
      );

      if (response.ok) {
        const data = await response.json();
        return data.config || null;
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to get variant config:', e);
      }
    }

    // Fallback to cached
    const experiment = this.cachedExperiments.find(
      (exp) => exp.id === experimentKey || exp.name === experimentKey
    );
    if (experiment) {
      const cached = await this.getCachedAssignment(experimentKey);
      if (cached) {
        const variant = experiment.variants.find(
          (v) => v.id === cached.variantId
        );
        return variant?.config || null;
      }
    }

    return null;
  }

  // ============================================
  // CORE EVENT TRACKING
  // ============================================

  async trackView(experimentKey: string): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.VIEW);
  }

  async trackClick(experimentKey: string): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.CLICK);
  }

  async trackConversion(
    experimentKey: string,
    value?: number
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.CONVERSION, {
      eventValue: value,
    });
  }

  async trackCustomEvent(
    experimentKey: string,
    eventName: string,
    properties?: Record<string, any>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.CUSTOM, {
      eventName,
      metadata: properties,
    });
  }

  // ============================================
  // ENGAGEMENT EVENTS
  // ============================================

  async trackScroll(
    experimentKey: string,
    depth?: number,
    properties?: Record<string, any>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.SCROLL, {
      eventValue: depth,
      metadata: properties,
    });
  }

  async trackFormSubmit(
    experimentKey: string,
    formName?: string,
    properties?: Record<string, any>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.FORM_SUBMIT, {
      eventName: formName,
      metadata: properties,
    });
  }

  async trackSearch(
    experimentKey: string,
    query?: string,
    properties?: Record<string, any>
  ): Promise<void> {
    const metadata = {
      ...(query ? { query } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.SEARCH, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackShare(
    experimentKey: string,
    method?: string,
    properties?: Record<string, any>
  ): Promise<void> {
    const metadata = {
      ...(method ? { method } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.SHARE, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  // ============================================
  // E-COMMERCE EVENTS
  // ============================================

  async trackAddToCart(
    experimentKey: string,
    value?: number,
    productId?: string,
    properties?: Record<string, any>
  ): Promise<void> {
    const metadata = {
      ...(productId ? { productId } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.ADD_TO_CART, {
      eventValue: value,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackRemoveFromCart(
    experimentKey: string,
    value?: number,
    productId?: string,
    properties?: Record<string, any>
  ): Promise<void> {
    const metadata = {
      ...(productId ? { productId } : {}),
      ...properties,
    };
    await this.trackEventInternal(
      experimentKey,
      EventType.REMOVE_FROM_CART,
      {
        eventValue: value,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      }
    );
  }

  async trackBeginCheckout(
    experimentKey: string,
    value?: number,
    properties?: Record<string, any>
  ): Promise<void> {
    await this.trackEventInternal(
      experimentKey,
      EventType.BEGIN_CHECKOUT,
      {
        eventValue: value,
        metadata: properties,
      }
    );
  }

  async trackPurchase(
    experimentKey: string,
    value: number,
    transactionId?: string,
    properties?: Record<string, any>
  ): Promise<void> {
    const metadata = {
      ...(transactionId ? { transactionId } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.PURCHASE, {
      eventValue: value,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  // ============================================
  // MEDIA EVENTS
  // ============================================

  async trackVideoStart(
    experimentKey: string,
    videoId?: string,
    properties?: Record<string, any>
  ): Promise<void> {
    const metadata = {
      ...(videoId ? { videoId } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.VIDEO_START, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackVideoComplete(
    experimentKey: string,
    videoId?: string,
    properties?: Record<string, any>
  ): Promise<void> {
    const metadata = {
      ...(videoId ? { videoId } : {}),
      ...properties,
    };
    await this.trackEventInternal(
      experimentKey,
      EventType.VIDEO_COMPLETE,
      {
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      }
    );
  }

  // ============================================
  // USER AUTH EVENTS
  // ============================================

  async trackSignUp(
    experimentKey: string,
    method?: string,
    properties?: Record<string, any>
  ): Promise<void> {
    const metadata = {
      ...(method ? { method } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.SIGN_UP, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackLogin(
    experimentKey: string,
    method?: string,
    properties?: Record<string, any>
  ): Promise<void> {
    const metadata = {
      ...(method ? { method } : {}),
      ...properties,
    };
    await this.trackEventInternal(experimentKey, EventType.LOGIN, {
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async trackLogout(
    experimentKey: string,
    properties?: Record<string, any>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, EventType.LOGOUT, {
      metadata: properties,
    });
  }

  // ============================================
  // GENERIC EVENT TRACKING
  // ============================================

  async trackEvent(
    experimentKey: string,
    eventType: EventType,
    eventName?: string,
    value?: number,
    properties?: Record<string, any>
  ): Promise<void> {
    await this.trackEventInternal(experimentKey, eventType, {
      eventName: eventName || eventType,
      eventValue: value,
      metadata: properties,
    });
  }

  // ============================================
  // EXPERIMENTS
  // ============================================

  async refreshExperiments(): Promise<void> {
    this.ensureInitialized();
    await this.fetchExperiments();
  }

  async getExperiments(): Promise<Experiment[]> {
    this.ensureInitialized();
    return this.cachedExperiments.map((e) => ({
      id: e.id,
      key: e.id,
      name: e.name,
      status: 'running' as const,
      trafficAllocation: e.trafficAllocation,
      variants: e.variants.map((v) => ({
        id: v.id,
        key: v.id,
        name: v.name,
        trafficSplit: v.trafficSplit,
        isControl: v.isControl,
        config: v.config,
      })),
    }));
  }

  // ============================================
  // FEATURE FLAGS
  // ============================================

  async isFeatureEnabled(
    featureKey: string,
    defaultValue: boolean = false
  ): Promise<boolean> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flag-evaluation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config!.apiKey,
        },
        body: JSON.stringify({
          flagKey: featureKey,
          userId: this.userId || '',
          userAttributes: this.userAttributes,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.enabled ?? defaultValue;
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to check feature flag:', e);
      }
    }

    return defaultValue;
  }

  async getFeatureValue(
    featureKey: string,
    defaultValue?: any
  ): Promise<any> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flag-evaluation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config!.apiKey,
        },
        body: JSON.stringify({
          flagKey: featureKey,
          userId: this.userId || '',
          userAttributes: this.userAttributes,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.value ?? defaultValue;
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to get feature value:', e);
      }
    }

    return defaultValue;
  }

  async getFeatureFlags(): Promise<FeatureFlag[]> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flags`, {
        headers: { 'x-api-key': this.config!.apiKey },
      });

      if (response.ok) {
        const data = await response.json();
        return (data.flags as FeatureFlag[]) || [];
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to get feature flags:', e);
      }
    }

    return [];
  }

  async refreshFeatureFlags(): Promise<void> {
    this.ensureInitialized();

    try {
      const response = await fetch(`${API_URL}/public/flags`, {
        headers: { 'x-api-key': this.config!.apiKey },
      });

      if (response.ok) {
        const data = await response.json();
        this.emit('featureFlagsRefreshed', data);
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to refresh feature flags:', e);
      }
      this.emit('error', {
        message: `Failed to refresh feature flags: ${e}`,
      });
    }
  }

  // ============================================
  // FLUSH & LIFECYCLE
  // ============================================

  async flush(): Promise<void> {
    this.ensureInitialized();
    await this.syncEvents();
  }

  async reset(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;

    this.userId = null;
    this.userAttributes = {};
    this.cachedExperiments = [];
    this.eventQueue = [];
    this.isInitialized = false;

    // Clear persisted state
    const keys = await AsyncStorage.getAllKeys();
    const riviumKeys = keys.filter((k: string) => k.startsWith(STORAGE_PREFIX));
    if (riviumKeys.length > 0) {
      await AsyncStorage.multiRemove(riviumKeys);
    }
  }

  // ============================================
  // EVENT LISTENERS
  // ============================================

  on(event: RiviumAbTestingEventType, callback: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);

    return () => this.off(event, callback);
  }

  off(event: RiviumAbTestingEventType, callback: EventCallback): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  // ============================================
  // PRIVATE: EVENT SYSTEM
  // ============================================

  private emit(event: RiviumAbTestingEventType, data: any): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((cb) => cb({ type: event, data }));
    }
  }

  // ============================================
  // PRIVATE: VALIDATION
  // ============================================

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error(
        'RiviumAbTesting SDK not initialized. Call init() first.'
      );
    }
  }

  private ensureUserId(): void {
    if (!this.userId) {
      throw new Error('User ID not set. Call setUserId() first.');
    }
  }

  // ============================================
  // PRIVATE: PERSISTENCE
  // ============================================

  private async loadPersistedState(): Promise<void> {
    try {
      const [userId, experiments, events] = await AsyncStorage.multiGet([
        `${STORAGE_PREFIX}user_id`,
        `${STORAGE_PREFIX}experiments`,
        `${STORAGE_PREFIX}events`,
      ]);

      if (userId[1]) this.userId = userId[1];
      if (experiments[1])
        this.cachedExperiments = JSON.parse(experiments[1]);
      if (events[1]) this.eventQueue = JSON.parse(events[1]);
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to load persisted state:', e);
      }
    }
  }

  private async persistEvents(): Promise<void> {
    try {
      await AsyncStorage.setItem(
        `${STORAGE_PREFIX}events`,
        JSON.stringify(this.eventQueue)
      );
    } catch (e) {
      // Silently fail
    }
  }

  private async getCachedAssignment(
    experimentId: string
  ): Promise<CachedAssignment | null> {
    try {
      const raw = await AsyncStorage.getItem(
        `${STORAGE_PREFIX}assignment_${experimentId}`
      );
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private async cacheAssignment(assignment: CachedAssignment): Promise<void> {
    try {
      await AsyncStorage.setItem(
        `${STORAGE_PREFIX}assignment_${assignment.experimentId}`,
        JSON.stringify(assignment)
      );
    } catch {
      // Silently fail
    }
  }

  // ============================================
  // PRIVATE: EVENT TRACKING
  // ============================================

  private async trackEventInternal(
    experimentKey: string,
    eventType: EventType,
    options?: {
      eventName?: string;
      eventValue?: number;
      metadata?: Record<string, any>;
    }
  ): Promise<void> {
    this.ensureInitialized();
    this.ensureUserId();

    // Get variant ID from cached assignment
    const cached = await this.getCachedAssignment(experimentKey);
    const variantId = cached?.variantId || '';

    const event: OfflineEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      experimentId: experimentKey,
      variantId,
      userId: this.userId!,
      eventType,
      eventName: options?.eventName || eventType,
      eventValue: options?.eventValue,
      metadata: options?.metadata,
      timestamp: new Date().toISOString(),
      retryCount: 0,
    };

    // Enforce max queue size
    if (this.eventQueue.length >= this.syncConfig.maxOfflineEvents) {
      this.eventQueue.shift();
    }

    this.eventQueue.push(event);
    await this.persistEvents();

    if (this.config?.debug) {
      console.log(
        `RiviumAbTesting: Queued ${eventType} event for experiment ${experimentKey}`
      );
    }

    // Auto-flush if batch is full
    if (this.eventQueue.length >= this.syncConfig.maxBatchSize) {
      this.syncEvents().catch(() => {});
    }
  }

  // ============================================
  // PRIVATE: SYNC
  // ============================================

  private startSyncTimer(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(
      () => this.syncEvents().catch(() => {}),
      this.syncConfig.syncIntervalSeconds * 1000
    );
  }

  private async syncEvents(): Promise<void> {
    if (this.isSyncing || this.eventQueue.length === 0) return;

    this.isSyncing = true;

    try {
      const batch = this.eventQueue.slice(0, this.syncConfig.maxBatchSize);

      const response = await fetch(`${API_URL}/public/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config!.apiKey,
        },
        body: JSON.stringify({
          events: batch.map((e) => ({
            experimentId: e.experimentId,
            variantId: e.variantId,
            userId: e.userId,
            eventType: e.eventType,
            eventName: e.eventName,
            eventValue: e.eventValue,
            metadata: e.metadata,
            timestamp: e.timestamp,
            clientEventId: e.id,
          })),
          sdkVersion: 'react-native-0.1.0',
        }),
      });

      if (response.ok) {
        const result = await response.json();
        const synced = result.synced || 0;

        // Remove synced events
        this.eventQueue.splice(0, synced);

        // Increment retry count for failed events
        const failed = result.failed || 0;
        if (failed > 0) {
          for (let i = 0; i < Math.min(failed, this.eventQueue.length); i++) {
            this.eventQueue[i].retryCount++;
            if (this.eventQueue[i].retryCount >= this.syncConfig.maxRetries) {
              this.eventQueue.splice(i, 1);
              i--;
            }
          }
        }

        await this.persistEvents();

        this.emit('syncCompleted', {
          synced,
          failed,
          pending: this.eventQueue.length,
        });
      }
    } catch (e) {
      this.emit('error', { message: `Sync failed: ${e}` });
    } finally {
      this.isSyncing = false;
    }
  }

  // ============================================
  // PRIVATE: EXPERIMENTS
  // ============================================

  private async fetchExperiments(): Promise<void> {
    try {
      const response = await fetch(
        `${API_URL}/public/init?platform=react-native&sdkVersion=0.1.0`,
        {
          headers: { 'x-api-key': this.config!.apiKey },
        }
      );

      if (response.ok) {
        const data = await response.json();

        const experimentsList = data.experiments || [];
        this.cachedExperiments = experimentsList.map((e: any) => ({
          id: e.id,
          name: e.name,
          trafficAllocation: e.trafficAllocation ?? 100,
          variants: (e.variants || []).map((v: any) => ({
            id: v.id,
            name: v.name,
            config: v.config || null,
            isControl: v.isControl ?? false,
            trafficSplit: v.trafficSplit ?? 50,
          })),
          cachedAt: new Date().toISOString(),
        }));

        await AsyncStorage.setItem(
          `${STORAGE_PREFIX}experiments`,
          JSON.stringify(this.cachedExperiments)
        );

        if (data.config) {
          this.syncConfig = {
            ...this.syncConfig,
            ...data.config,
          };
          this.startSyncTimer();
        }

        this.emit('experimentsRefreshed', {
          count: this.cachedExperiments.length,
        });

        if (this.config?.debug) {
          console.log(
            `RiviumAbTesting: Fetched ${this.cachedExperiments.length} experiments`
          );
        }
      }
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to fetch experiments:', e);
      }
      this.emit('error', {
        message: `Failed to fetch experiments: ${e}`,
      });
    }
  }

  // ============================================
  // PRIVATE: LOCAL BUCKETING
  // ============================================

  private async getLocalAssignment(
    experimentKey: string,
    defaultVariant: string
  ): Promise<string> {
    const experiment = this.cachedExperiments.find(
      (e) => e.id === experimentKey
    );
    if (!experiment) return defaultVariant;

    // Check traffic allocation
    const bucket = this.getBucket(this.userId!, experimentKey);
    if (bucket > experiment.trafficAllocation) {
      const control = experiment.variants.find((v) => v.isControl);
      return control ? control.name : defaultVariant;
    }

    // Assign based on traffic split
    let cumulativeSplit = 0;
    const variantBucket = this.getBucket(
      this.userId!,
      `${experimentKey}:variant`
    );

    for (const variant of experiment.variants) {
      cumulativeSplit += variant.trafficSplit;
      if (variantBucket <= cumulativeSplit) {
        await this.cacheAssignment({
          experimentId: experimentKey,
          variantId: variant.id,
          variantName: variant.name,
          assignedAt: new Date().toISOString(),
        });

        this.emit('experimentAssigned', {
          experimentKey,
          variantKey: variant.name,
          config: variant.config,
        });

        return variant.name;
      }
    }

    return defaultVariant;
  }

  private getBucket(userId: string, salt: string): number {
    const hash = createHash(`${userId}:${salt}`);
    const hashInt = parseInt(hash.substring(0, 8), 16);
    return (hashInt % 100) + 1; // 1-100
  }

  // ============================================
  // PRIVATE: APP STATE
  // ============================================

  private onAppStateChange = (state: AppStateStatus): void => {
    if (state === 'background' && this.eventQueue.length > 0) {
      this.syncEvents().catch(() => {});
    }
  };
}

export const RiviumAbTesting = new RiviumAbTestingSDK();
export default RiviumAbTesting;

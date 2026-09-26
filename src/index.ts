import { AppState, type AppStateStatus } from 'react-native';
import { Storage } from './storage';
import { createHash } from './hash';

const API_URL = 'https://abtest.rivium.co';
const SDK_VERSION = '0.2.0';
/** Fetch a new user token this many seconds before the current one expires. */
const TOKEN_REFRESH_SKEW_S = 60;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64url -> text, without atob (absent on older React Native engines). */
function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const ch of b64) {
    const index = BASE64_ALPHABET.indexOf(ch);
    if (index < 0) throw new Error('invalid base64');
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  // The token payload is JSON; decode its UTF-8 bytes.
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
}

// ============================================
// TYPES & INTERFACES
// ============================================

export interface RiviumAbTestingConfig {
  /** API key for authentication (format: rv_live_xxx or rv_test_xxx) */
  apiKey: string;
  /**
   * Returns a Rivium user token for the signed-in user, minted by YOUR server
   * (POST https://auth.rivium.co/users/token with your server secret). The
   * service then takes the user from the token instead of trusting the
   * userId this app sends. Called when a token is needed and again shortly
   * before it expires. Required for
   * assigning variants, tracking events and evaluating flags.
   */
  tokenProvider?: () => string | Promise<string>;
  /** A user token you already hold. `tokenProvider` is preferred: a static token expires. */
  userToken?: string;
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
  VIEW = 'view',
  CLICK = 'click',
  CONVERSION = 'conversion',
  CUSTOM = 'custom',
  SCROLL = 'scroll',
  FORM_SUBMIT = 'form_submit',
  SEARCH = 'search',
  SHARE = 'share',
  ADD_TO_CART = 'add_to_cart',
  REMOVE_FROM_CART = 'remove_from_cart',
  BEGIN_CHECKOUT = 'begin_checkout',
  PURCHASE = 'purchase',
  VIDEO_START = 'video_start',
  VIDEO_COMPLETE = 'video_complete',
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
  config?: Record<string, any>;
  assignedAt: string;
}

interface CachedExperiment {
  id: string;
  key?: string;
  name: string;
  trafficAllocation: number;
  variants: {
    id: string;
    key?: string;
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

  // User token (see RiviumAbTestingConfig.tokenProvider)
  private userToken?: string;
  private userTokenExpiresAt = 0;
  private userTokenInFlight?: Promise<string | undefined>;

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
    this.syncConfig.syncIntervalSeconds = Math.max(1, Math.floor(interval / 1000));
    if (config.maxQueueSize) this.syncConfig.maxOfflineEvents = config.maxQueueSize;
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
    if (userId !== this.userId) {
      // Send the last user's pending events while their token still applies.
      if (this.userId && this.eventQueue.length > 0) {
        await this.syncEvents().catch(() => {});
      }
      // Another person now (a login, a logout, a shared computer): the last
      // user's variants, attributes and token are not theirs.
      await this.clearAssignments();
      this.userAttributes = {};
      this.clearUserToken();
    }
    this.userId = userId;
    await Storage.setItem('user_id', userId);
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
      const response = await this.request('/public/assign', {
        method: 'POST',
        body: JSON.stringify({
          experimentKey,
          userId: this.userId,
          ...(Object.keys(this.userAttributes).length > 0
            ? { userAttributes: this.userAttributes }
            : {}),
        }),
      });

      if (response.ok) {
        const body = await response.json();
        const data = (body?.data ?? {}) as Record<string, any>;
        const variantName = (data.variantName as string) || (data.variantKey as string);

        if (variantName) {
          await this.cacheAssignment(experimentKey, {
            experimentId: data.experimentId as string,
            variantId: data.variantId as string,
            variantName,
            config: data.config as Record<string, any> | undefined,
            assignedAt: new Date().toISOString(),
          });

          this.emit('experimentAssigned', {
            experimentKey,
            variantKey: variantName,
            config: data.config,
          });

          return variantName;
        }
      } else {
        this.debugLog(`Assignment for ${experimentKey} refused: HTTP ${response.status}`);
      }
    } catch (e) {
      this.debugLog('Failed to get assignment from server:', e);
    }

    // Offline fallback: local bucketing
    return this.getLocalAssignment(experimentKey, defaultVariant);
  }

  async getVariantConfig(
    experimentKey: string
  ): Promise<Record<string, any> | null> {
    this.ensureInitialized();

    // The assignment carries the variant's config; make sure there is one.
    let cached = await this.getCachedAssignment(experimentKey);
    if (!cached && this.userId) {
      await this.getVariant(experimentKey);
      cached = await this.getCachedAssignment(experimentKey);
    }
    if (!cached) return null;
    if (cached.config) return cached.config;

    const experiment = this.findExperiment(experimentKey);
    const variant = experiment?.variants.find((v) => v.id === cached!.variantId);
    return variant?.config || null;
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
      key: e.key || e.id,
      name: e.name,
      status: 'running' as const,
      trafficAllocation: e.trafficAllocation,
      variants: e.variants.map((v) => ({
        id: v.id,
        key: v.key || v.id,
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
      const response = await this.request('/public/flag-evaluation', {
        method: 'POST',
        body: JSON.stringify({
          flagKey: featureKey,
          userId: this.userId || '',
          userAttributes: this.userAttributes,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return (data.enabled as boolean) ?? defaultValue;
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
      const response = await this.request('/public/flag-evaluation', {
        method: 'POST',
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
      const response = await this.request('/public/flags');

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
      const response = await this.request('/public/flags');

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
    this.clearUserToken();

    // Clear persisted state
    const keys = await Storage.getAllKeys();
    if (keys.length > 0) {
      await Storage.multiRemove(keys);
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
      const results = await Storage.multiGet([
        'user_id',
        'experiments',
        'events',
      ]);

      const userId = results[0][1];
      const experiments = results[1][1];
      const events = results[2][1];

      if (userId) this.userId = userId;
      if (experiments) this.cachedExperiments = JSON.parse(experiments);
      if (events) this.eventQueue = JSON.parse(events);
    } catch (e) {
      if (this.config?.debug) {
        console.log('RiviumAbTesting: Failed to load persisted state:', e);
      }
    }
  }

  private async persistEvents(): Promise<void> {
    try {
      await Storage.setItem('events', JSON.stringify(this.eventQueue));
    } catch {
      // Silently fail
    }
  }

  private async getCachedAssignment(
    experimentKey: string
  ): Promise<CachedAssignment | null> {
    try {
      const raw = await Storage.getItem(`assignment_${experimentKey}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private async cacheAssignment(
    experimentKey: string,
    assignment: CachedAssignment
  ): Promise<void> {
    try {
      await Storage.setItem(`assignment_${experimentKey}`, JSON.stringify(assignment));
    } catch {
      // Silently fail
    }
  }

  private async clearAssignments(): Promise<void> {
    const prefix = Storage.fullKey('assignment_');
    const keys = (await Storage.getAllKeys()).filter((k) => k.startsWith(prefix));
    if (keys.length > 0) {
      await Storage.multiRemove(keys);
    }
  }

  private findExperiment(experimentKey: string): CachedExperiment | undefined {
    return this.cachedExperiments.find(
      (e) => e.key === experimentKey || e.id === experimentKey
    );
  }

  private debugLog(message: string, detail?: unknown): void {
    if (this.config?.debug) {
      if (detail === undefined) console.log(`RiviumAbTesting: ${message}`);
      else console.log(`RiviumAbTesting: ${message}`, detail);
    }
  }

  // ============================================
  // PRIVATE: REQUESTS & USER TOKEN
  // ============================================

  /**
   * Every call to the service goes through here: API key, user token, and
   * one retry with a fresh token when the service says the token expired.
   */
  private async request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config!.apiKey,
    };
    const token = await this.getUserToken();
    if (token) {
      headers['x-user-token'] = token;
    }

    const response = await fetch(`${API_URL}${path}`, { ...init, headers });

    if (response.status === 401 && retry && (this.config?.tokenProvider || this.config?.userToken)) {
      const body = await response.clone().json().catch(() => null);
      if (body?.code === 'token_expired' && this.config?.tokenProvider) {
        this.clearUserToken();
        return this.request(path, init, false);
      }
      if (body?.code) {
        this.emit('error', { message: `User token rejected: ${body.code}`, code: body.code });
      }
    }
    return response;
  }

  /** The current user token, fetched through tokenProvider when needed. */
  private async getUserToken(): Promise<string | undefined> {
    if (this.config?.userToken) return this.config.userToken;
    if (!this.config?.tokenProvider) return undefined;

    const nowS = Math.floor(Date.now() / 1000);
    if (this.userToken && this.userTokenExpiresAt - TOKEN_REFRESH_SKEW_S > nowS) {
      return this.userToken;
    }
    if (this.userTokenInFlight) return this.userTokenInFlight;

    this.userTokenInFlight = (async () => {
      try {
        const token = await this.config!.tokenProvider!();
        this.userToken = token;
        this.userTokenExpiresAt = this.tokenExpiry(token);
        return token;
      } catch (e) {
        this.debugLog('tokenProvider failed:', e);
        return this.userToken;
      } finally {
        this.userTokenInFlight = undefined;
      }
    })();
    return this.userTokenInFlight;
  }

  private usesUserToken(): boolean {
    return !!(this.config?.tokenProvider || this.config?.userToken);
  }

  private clearUserToken(): void {
    this.userToken = undefined;
    this.userTokenExpiresAt = 0;
  }

  /** `exp` from the token's payload; 0 (refetch next time) if unreadable. */
  private tokenExpiry(token: string): number {
    try {
      const json = JSON.parse(base64UrlDecode(token.split('.')[1]));
      return typeof json.exp === 'number' ? json.exp : 0;
    } catch {
      return 0;
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
      // With a user token the service credits every event in the batch to
      // the token's user, so another user's leftover events cannot be sent
      // under it - they would be credited to the wrong person.
      if (this.usesUserToken()) {
        const before = this.eventQueue.length;
        this.eventQueue = this.eventQueue.filter((e) => e.userId === this.userId);
        if (this.eventQueue.length !== before) await this.persistEvents();
        if (this.eventQueue.length === 0) return;
      }

      const batch = this.eventQueue.slice(0, this.syncConfig.maxBatchSize);

      const response = await this.request('/public/sync', {
        method: 'POST',
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
          sdkVersion: `react-native-${SDK_VERSION}`,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        // The service has taken the whole batch. Events it could not record
        // (an experiment that no longer exists, say) would fail again, so
        // they are not retried.
        this.eventQueue.splice(0, batch.length);
        await this.persistEvents();

        this.emit('syncCompleted', {
          synced: (result.synced as number) || 0,
          failed: (result.failed as number) || 0,
          pending: this.eventQueue.length,
        });
      } else if (response.status === 401) {
        // No valid user token yet : keep the
        // events and send them once a token is available.
      } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        // The request itself is wrong; the same events cannot succeed.
        this.eventQueue.splice(0, batch.length);
        await this.persistEvents();
        this.emit('error', { message: `Sync refused: HTTP ${response.status}` });
      }
      // 429 and 5xx: keep the events and try again on the next tick.
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
      const response = await this.request(
        `/public/init?platform=react-native&sdkVersion=${SDK_VERSION}`
      );

      if (response.ok) {
        const data = await response.json();

        const experimentsList = (data.experiments as Array<Record<string, any>>) || [];
        this.cachedExperiments = experimentsList.map((e) => ({
          id: e.id as string,
          key: (e.key as string) || undefined,
          name: e.name as string,
          trafficAllocation: (e.trafficAllocation as number) ?? 100,
          variants: ((e.variants as Array<Record<string, any>>) || []).map((v) => ({
            id: v.id as string,
            key: (v.key as string) || undefined,
            name: v.name as string,
            config: (v.config as Record<string, any>) || undefined,
            isControl: (v.isControl as boolean) ?? false,
            trafficSplit: (v.trafficSplit as number) ?? 50,
          })),
          cachedAt: new Date().toISOString(),
        }));

        await Storage.setItem(
          'experiments',
          JSON.stringify(this.cachedExperiments)
        );

        const serverConfig = data.config as Partial<SyncConfig> | undefined;
        if (serverConfig) {
          this.syncConfig = {
            ...this.syncConfig,
            syncIntervalSeconds: serverConfig.syncIntervalSeconds ?? this.syncConfig.syncIntervalSeconds,
            maxBatchSize: serverConfig.maxBatchSize ?? this.syncConfig.maxBatchSize,
            maxOfflineEvents:
              this.config?.maxQueueSize ?? serverConfig.maxOfflineEvents ?? this.syncConfig.maxOfflineEvents,
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
    const experiment = this.findExperiment(experimentKey);
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
        await this.cacheAssignment(experimentKey, {
          experimentId: experiment.id,
          variantId: variant.id,
          variantName: variant.name,
          config: variant.config,
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

  private onAppStateChange = (state: AppStateStatus): void => {
    if (state === 'background' && this.eventQueue.length > 0) {
      this.syncEvents().catch(() => {});
    }
  };

  private getBucket(userId: string, salt: string): number {
    const hash = createHash(`${userId}:${salt}`);
    const hashInt = parseInt(hash.substring(0, 8), 16);
    return (hashInt % 100) + 1; // 1-100
  }
}

export const RiviumAbTesting = new RiviumAbTestingSDK();
export default RiviumAbTesting;

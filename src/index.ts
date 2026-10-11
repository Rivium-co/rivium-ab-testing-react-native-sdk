import { AppState, type AppStateStatus } from 'react-native';
import { Storage } from './storage';

const API_URL = 'https://abtest.rivium.co';
const SDK_VERSION = '0.2.3';
/** Fetch a new user token this many seconds before the current one expires. */
const TOKEN_REFRESH_SKEW_S = 60;
/** While waiting for a user token, ask `tokenProvider` again at most this often. */
const TOKEN_RECHECK_MS = 30000;
/** Most events kept while they cannot be sent; the oldest are dropped first. */
const MAX_QUEUED_EVENTS = 1000;
/** Most events in one request. */
const MAX_BATCH_SIZE = 100;
/** Longest pause after repeated failures. */
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;

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
   *
   * Return `null` when no one is signed in, and call `refreshUserToken()` when
   * the user signs in or out. Until there is a token the SDK waits
   * (`isAwaitingUserToken`): variants and flags return your defaults and
   * events are kept, nothing is sent.
   */
  tokenProvider?: () => string | null | undefined | Promise<string | null | undefined>;
  /** A user token you already hold. `tokenProvider` is preferred: a static token expires. */
  userToken?: string;
  debug?: boolean;
  /**
   * How often queued events are sent, in milliseconds. Leave it out to follow
   * the send interval set in the Rivium console (30000 until the console's
   * value is known). A value you pass is your own choice and is always used.
   */
  flushInterval?: number;
  /** Most events kept while they cannot be sent. Default and maximum 1000. */
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
  | 'onlineMode'
  /** The SDK started waiting for a user token (see `isAwaitingUserToken`). */
  | 'awaitingUserToken'
  /** A user token arrived, or the signed-in user changed: read variants again. */
  | 'userTokenReady';

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
  /** The user this assignment belongs to. */
  userId?: string;
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
// HELPERS
// ============================================

/** The claims of a user token; empty if it cannot be read. */
function tokenClaims(token: string): { exp?: unknown; sub?: unknown } {
  try {
    return JSON.parse(base64UrlDecode(token.split('.')[1]));
  } catch {
    return {};
  }
}

const DEFAULT_LIST_CACHE_S = 300;
/** After a list refresh that failed, the next one waits this long. */
const LIST_RETRY_MS = 60_000;
// Whatever the console says, events are never sent more often than every 10
// seconds and the experiment list is never asked for more than once a minute.
const SEND_INTERVAL_BOUNDS_S: [number, number] = [10, 3600];
const LIST_CACHE_BOUNDS_S: [number, number] = [60, 86_400];

/** A whole number of seconds from the service, brought inside the bounds; undefined when it is not one. */
function boundedSeconds(value: unknown, [min, max]: [number, number]): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined;
  return Math.min(Math.max(value, min), max);
}

/** The time an event was recorded, as milliseconds since 1970. */
function eventTimeMs(timestamp: string): number | string {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : timestamp;
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
  private assignments: Map<string, CachedAssignment> = new Map();
  private eventQueue: OfflineEvent[] = [];
  // Goes up whenever the user changes: an answer that was requested under
  // another value belongs to someone else and is thrown away.
  private userEpoch = 0;

  // Sync
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncInFlight?: Promise<void>;
  private lastUserFlush?: Promise<void>;
  private sendingIds: Set<string> = new Set();
  private assignInFlight: Map<string, Promise<CachedAssignment | null>> = new Map();
  private syncPausedUntil = 0;
  private syncFailures = 0;
  private rateLimitedUntil = 0;
  private eventLimitReported = false;
  private syncConfig: SyncConfig = {
    syncIntervalSeconds: 30,
    maxBatchSize: MAX_BATCH_SIZE,
    maxOfflineEvents: MAX_QUEUED_EVENTS,
    maxRetries: 3,
  };

  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

  // User token (see RiviumAbTestingConfig.tokenProvider)
  private userToken?: string;
  private userTokenExpiresAt = 0;
  private userTokenInFlight?: Promise<string | undefined>;
  private userTokenGeneration = 0;
  private awaitingUserToken = false;
  private awaitingUserTokenListeners: Set<() => void> = new Set();
  private tokenProviderFailed = false;
  private refusedUserToken?: string;
  private lastProviderAsk = 0;

  // What the console says about sending and caching.
  /** True when the app passed its own `flushInterval`: it wins over the console's send interval. */
  private ownFlushInterval = false;
  /** How long the experiment list is used before the service is asked again. */
  private listCacheSeconds = DEFAULT_LIST_CACHE_S;
  private listFetchedAt = 0;
  private listRetryAt = 0;
  private listLoads = 0;

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
    this.ownFlushInterval = !!config.flushInterval;
    this.syncConfig.syncIntervalSeconds = Math.max(1, Math.floor(interval / 1000));
    this.syncConfig.maxOfflineEvents = this.queueLimit(config.maxQueueSize);
    this.trimQueue();
    this.startSyncTimer();

    // Listen for app state changes to flush on background
    this.appStateSubscription?.remove();
    this.appStateSubscription = AppState.addEventListener(
      'change',
      this.onAppStateChange
    );

    this.isInitialized = true;

    // Fetch fresh experiments
    this.fetchExperiments().catch(() => {});

    this.emit('initialized', { offline: false });

    // Who is signed in? Without a token the SDK waits for one.
    if (config.userToken) {
      await this.acceptUserToken(config.userToken);
    } else if (config.tokenProvider) {
      this.askTokenProvider().catch(() => {});
    } else {
      this.startAwaitingUserToken();
    }
  }

  // ============================================
  // USER MANAGEMENT
  // ============================================

  async setUserId(userId: string): Promise<void> {
    if (!this.ready('setUserId')) return;
    if (!userId) {
      await this.clearUserId();
      return;
    }
    if (userId !== this.userId) {
      // Another person now (a login, a logout, a shared device): the last
      // user's variants, attributes, token and unsent events are not theirs.
      await this.changeUser(userId);
    }
    // A sign-in is when a token becomes available: ask for it now.
    if (!this.currentUserToken() && this.config?.tokenProvider) {
      await this.askTokenProvider();
    }
  }

  /**
   * Signs the user out of the SDK: sends their pending events under their
   * own token, then drops their variants, attributes, token and stored id.
   * Call it on logout so the next user of this device starts clean.
   */
  async clearUserId(): Promise<void> {
    if (!this.ready('clearUserId')) return;
    await this.changeUser(null);
    this.startAwaitingUserToken();
  }

  async getUserId(): Promise<string | null> {
    return this.userId;
  }

  async setUserAttributes(attributes: Record<string, any>): Promise<void> {
    if (!this.ready('setUserAttributes')) return;
    this.userAttributes = { ...this.userAttributes, ...attributes };
  }

  // ============================================
  // USER TOKEN
  // ============================================

  /**
   * True while the SDK is waiting for a user token: no one is signed in yet,
   * or the token was refused. Variants and flags return your defaults and
   * events are kept, nothing is sent. The SDK continues by itself after
   * `setUserToken()` or `refreshUserToken()`.
   */
  get isAwaitingUserToken(): boolean {
    return this.awaitingUserToken;
  }

  /** Called when the SDK starts waiting for a user token. */
  onAwaitingUserToken(callback: () => void): () => void {
    this.awaitingUserTokenListeners.add(callback);
    return () => {
      this.awaitingUserTokenListeners.delete(callback);
    };
  }

  /**
   * Replace the user token, or pass `null` when the user signs out. The SDK
   * continues if it was waiting for a token, and starts clean if the token is
   * for a different user.
   */
  async setUserToken(token: string | null): Promise<void> {
    if (!this.ready('setUserToken')) return;
    if (!token) {
      await this.changeUser(null);
      this.startAwaitingUserToken();
      return;
    }
    if (token === this.userToken) return;
    // A token the provider is fetching right now is older than this one.
    this.userTokenGeneration++;
    this.userTokenInFlight = undefined;
    await this.acceptUserToken(token);
  }

  /**
   * Ask `tokenProvider` again. Call this when the user signs in or out; the
   * SDK then continues as that user, or waits if there is none.
   */
  async refreshUserToken(): Promise<void> {
    if (!this.ready('refreshUserToken')) return;
    if (!this.config?.tokenProvider) return;
    this.userTokenGeneration++;
    this.userTokenInFlight = undefined;
    this.userTokenExpiresAt = 0;
    await this.askTokenProvider();
  }

  // ============================================
  // EXPERIMENT ASSIGNMENT
  // ============================================

  async getVariant(
    experimentKey: string,
    defaultVariant: string = 'control'
  ): Promise<string> {
    if (!this.ready('getVariant')) return defaultVariant;
    this.refreshListIfStale();

    const assignment = await this.assignmentFor(experimentKey);
    return assignment ? assignment.variantName : defaultVariant;
  }

  async getVariantConfig(
    experimentKey: string
  ): Promise<Record<string, any> | null> {
    if (!this.ready('getVariantConfig')) return null;

    // The assignment carries the variant's config; make sure there is one.
    const cached = await this.assignmentFor(experimentKey);
    if (!cached) return null;
    if (cached.config) return cached.config;

    const experiment = this.findExperiment(experimentKey);
    const variant = experiment?.variants.find((v) => v.id === cached.variantId);
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
    if (!this.ready('refreshExperiments')) return;
    await this.fetchExperiments();
  }

  async getExperiments(): Promise<Experiment[]> {
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
    const data = await this.evaluateFlag(featureKey);
    return (data?.enabled as boolean | undefined) ?? defaultValue;
  }

  async getFeatureValue(
    featureKey: string,
    defaultValue?: any
  ): Promise<any> {
    const data = await this.evaluateFlag(featureKey);
    return data?.value ?? defaultValue;
  }

  async getFeatureFlags(): Promise<FeatureFlag[]> {
    if (!this.ready('getFeatureFlags')) return [];

    try {
      const response = await this.send('/public/flags');

      if (response.ok) {
        const data = await response.json();
        return (data.flags as FeatureFlag[]) || [];
      }
    } catch (e) {
      this.debugLog('Failed to get feature flags:', e);
    }

    return [];
  }

  async refreshFeatureFlags(): Promise<void> {
    if (!this.ready('refreshFeatureFlags')) return;

    try {
      const response = await this.send('/public/flags');

      if (response.ok) {
        const data = await response.json();
        this.emit('featureFlagsRefreshed', data);
      }
    } catch (e) {
      this.debugLog('Failed to refresh feature flags:', e);
      this.emit('error', {
        message: `Failed to refresh feature flags: ${e}`,
      });
    }
  }

  // ============================================
  // FLUSH & LIFECYCLE
  // ============================================

  async flush(): Promise<void> {
    if (!this.ready('flush')) return;
    await this.lastUserFlush;
    // A run that is already under way does not include the newest events.
    await this.syncInFlight;
    await this.syncEvents();
  }

  async reset(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    this.appStateSubscription?.remove();
    this.appStateSubscription = null;

    this.userEpoch++;
    this.userId = null;
    this.userAttributes = {};
    this.cachedExperiments = [];
    this.assignments.clear();
    this.assignInFlight.clear();
    this.eventQueue = [];
    this.isInitialized = false;
    this.ownFlushInterval = false;
    this.listCacheSeconds = DEFAULT_LIST_CACHE_S;
    this.listFetchedAt = 0;
    this.listRetryAt = 0;
    this.forgetUserToken();
    this.awaitingUserToken = false;
    this.tokenProviderFailed = false;
    this.refusedUserToken = undefined;
    this.lastProviderAsk = 0;
    this.syncPausedUntil = 0;
    this.syncFailures = 0;
    this.rateLimitedUntil = 0;
    this.eventLimitReported = false;

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
      // A listener that throws must not break the call that reported to it.
      [...callbacks].forEach((cb) => {
        try {
          cb({ type: event, data });
        } catch (e) {
          this.debugLog(`A '${event}' listener threw:`, e);
        }
      });
    }
  }

  // ============================================
  // PRIVATE: VALIDATION
  // ============================================

  /**
   * False before init(): the caller then returns its default instead of
   * throwing.
   */
  private ready(method: string): boolean {
    if (!this.isInitialized) {
      this.debugLog(`${method}() ignored: the SDK is not initialized. Call init() first.`);
    }
    return this.isInitialized;
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
      if (experiments) {
        const parsed = JSON.parse(experiments);
        if (Array.isArray(parsed)) this.cachedExperiments = parsed;
      }
      if (events) {
        const parsed = JSON.parse(events);
        if (Array.isArray(parsed)) this.eventQueue = parsed;
      }
    } catch (e) {
      this.debugLog('Failed to load persisted state:', e);
    }

    try {
      const prefix = Storage.fullKey('assignment_');
      const keys = (await Storage.getAllKeys()).filter((k) => k.startsWith(prefix));
      for (const fullKey of keys) {
        const experimentKey = fullKey.slice(prefix.length);
        const raw = await Storage.getItem(`assignment_${experimentKey}`);
        if (!raw) continue;
        const assignment = JSON.parse(raw) as CachedAssignment;
        // Only the stored user's own assignments.
        if (this.userId && (!assignment.userId || assignment.userId === this.userId)) {
          this.assignments.set(experimentKey, assignment);
        }
      }
    } catch (e) {
      this.debugLog('Failed to load cached assignments:', e);
    }
  }

  private async persistEvents(): Promise<void> {
    try {
      await Storage.setItem('events', JSON.stringify(this.eventQueue));
    } catch {
      // Silently fail
    }
  }

  private async cacheAssignment(
    experimentKey: string,
    assignment: CachedAssignment
  ): Promise<void> {
    this.assignments.set(experimentKey, assignment);
    try {
      await Storage.setItem(`assignment_${experimentKey}`, JSON.stringify(assignment));
    } catch {
      // Silently fail
    }
  }

  private async clearStoredAssignments(): Promise<void> {
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
  // PRIVATE: USERS
  // ============================================

  /**
   * Makes `next` the current user (`null`: nobody). Everything of the last
   * user goes first - variants, attributes, token, unsent events - so nothing
   * of theirs can be sent or shown for the next one.
   */
  private async changeUser(next: string | null, nextToken?: string): Promise<void> {
    const previous = this.userId;
    const token = this.userToken;
    const tokenUser = token ? this.tokenUser(token) : undefined;

    // The last user's unsent events can only go out under their own token.
    const leftovers =
      previous && token && (!tokenUser || tokenUser === previous)
        ? this.eventQueue.filter((e) => e.userId === previous && !this.sendingIds.has(e.id))
        : [];
    // A token that is already the next user's stays.
    const keepToken =
      !nextToken && !!token && next !== null && (tokenUser === next || (!tokenUser && previous === null));

    this.userEpoch++;
    this.userId = next;
    this.userAttributes = {};
    this.assignments.clear();
    this.assignInFlight.clear();
    // Events recorded for someone else, or for nobody, cannot be credited to
    // this user.
    this.eventQueue = next ? this.eventQueue.filter((e) => e.userId === next) : [];
    if (nextToken) {
      this.userToken = nextToken;
      this.userTokenExpiresAt = this.tokenExpiry(nextToken);
    } else if (!keepToken) {
      this.forgetUserToken();
    }

    if (leftovers.length > 0 && token) {
      const sending = this.sendLastEvents(leftovers, token);
      this.lastUserFlush = sending;
      sending.finally(() => {
        if (this.lastUserFlush === sending) this.lastUserFlush = undefined;
      });
    }

    if (next) await Storage.setItem('user_id', next);
    else await Storage.removeItem('user_id');
    await this.clearStoredAssignments();
    await this.persistEvents();

    if (!this.userToken && !this.config?.tokenProvider) {
      this.startAwaitingUserToken();
    }
  }

  /** One attempt to send a user's last events under their own token. */
  private async sendLastEvents(events: OfflineEvent[], token: string): Promise<void> {
    try {
      for (let i = 0; i < events.length; i += this.syncConfig.maxBatchSize) {
        if (Date.now() < this.rateLimitedUntil) return;
        const response = await this.postEvents(events.slice(i, i + this.syncConfig.maxBatchSize), token);
        if (response.status === 429) this.rateLimited(response);
        if (!response.ok) return;
      }
    } catch (e) {
      this.debugLog('Failed to send the last user\'s events:', e);
    }
  }

  // ============================================
  // PRIVATE: REQUESTS & USER TOKEN
  // ============================================

  /** One call to the service: API key, and the user token when one is given. */
  private async send(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config!.apiKey,
    };
    if (token) {
      headers['x-user-token'] = token;
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timeout = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : undefined;
    try {
      return await fetch(`${API_URL}${path}`, { ...init, headers, signal: controller?.signal });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * A call that acts for the signed-in user. Returns `null` when the call was
   * not completed because the SDK is (now) waiting for a user token. When the
   * service says the token expired, it is refreshed and the call repeated
   * once.
   */
  private async userRequest(path: string, init: RequestInit, token: string): Promise<Response | null> {
    const epoch = this.userEpoch;
    const response = await this.send(path, init, token);
    if (response.status === 429) this.rateLimited(response);
    if (response.status !== 401) return response;

    const code = await this.errorCode(response);
    if (code !== 'token_expired') {
      return this.userTokenRefused(token, code) ? null : response;
    }

    if (this.userToken === token) this.forgetUserToken();
    const fresh = await this.ensureUserToken();
    // The provider handed back the expired token: do not ask in a loop.
    if (fresh === token) this.userTokenRefused(token, code);
    // No new token, or it is another user's: this call is not theirs to make.
    if (!fresh || fresh === token || epoch !== this.userEpoch) return null;

    const retried = await this.send(path, init, fresh);
    if (retried.status === 429) this.rateLimited(retried);
    if (retried.status !== 401) return retried;
    const retriedCode = await this.errorCode(retried);
    return this.userTokenRefused(fresh, retriedCode ?? undefined) ? null : retried;
  }

  private async errorCode(response: Response): Promise<string | undefined> {
    const body = await response.clone().json().catch(() => null);
    return typeof body?.code === 'string' ? body.code : undefined;
  }

  /**
   * The service refused this token. The SDK stops using it and waits for
   * another one. False if the 401 was not about the user token.
   */
  private userTokenRefused(token: string, code: string | undefined): boolean {
    if (code !== 'token_required' && code !== 'token_invalid' && code !== 'token_expired') {
      return false;
    }
    const alreadyRefused = this.refusedUserToken === token;
    this.refusedUserToken = token;
    if (this.userToken === token) this.forgetUserToken();
    if (!this.currentUserToken()) this.startAwaitingUserToken();
    if (code === 'token_invalid' && !alreadyRefused) {
      this.emit('error', { message: `User token rejected: ${code}`, code });
    }
    return true;
  }

  /** The token in use, if it is still good; never asks `tokenProvider`. */
  private currentUserToken(): string | undefined {
    if (!this.userToken) return undefined;
    // Without a provider there is nothing to refresh it with: use it until
    // the service says it expired.
    if (!this.config?.tokenProvider) return this.userToken;
    const nowS = Math.floor(Date.now() / 1000);
    return this.userTokenExpiresAt - TOKEN_REFRESH_SKEW_S > nowS ? this.userToken : undefined;
  }

  /**
   * The current user token, fetched through tokenProvider when needed.
   * `undefined` means the SDK is waiting for one; while it waits this returns
   * at once.
   */
  private async ensureUserToken(): Promise<string | undefined> {
    const current = this.currentUserToken();
    if (current) return current;
    if (!this.config?.tokenProvider) {
      this.startAwaitingUserToken();
      return undefined;
    }
    if (this.awaitingUserToken) {
      // Nobody is signed in as far as the SDK knows. Look again now and then,
      // without holding up the caller.
      if (Date.now() - this.lastProviderAsk >= TOKEN_RECHECK_MS) {
        this.askTokenProvider().catch(() => {});
      }
      return undefined;
    }
    return this.askTokenProvider();
  }

  /** Asks tokenProvider; calls made meanwhile share the one request. */
  private askTokenProvider(): Promise<string | undefined> {
    if (this.userTokenInFlight) return this.userTokenInFlight;

    const generation = this.userTokenGeneration;
    this.lastProviderAsk = Date.now();
    const asking: Promise<string | undefined> = (async () => {
      let token: string | null | undefined;
      let failed = false;
      try {
        token = await this.config!.tokenProvider!();
      } catch (e) {
        failed = true;
        this.debugLog('tokenProvider failed:', e);
      }
      // The user changed, or the app set a token, while the provider worked.
      if (generation !== this.userTokenGeneration || !this.isInitialized) {
        return this.currentUserToken();
      }
      return this.acceptUserToken(token, failed);
    })().finally(() => {
      if (this.userTokenInFlight === asking) this.userTokenInFlight = undefined;
    });
    this.userTokenInFlight = asking;
    return asking;
  }

  /**
   * Takes a token from the provider or the app. No token means nobody is
   * signed in: the SDK waits. A token for another user starts that user clean.
   */
  private async acceptUserToken(
    token: string | null | undefined,
    providerFailed = false
  ): Promise<string | undefined> {
    this.tokenProviderFailed = providerFailed;

    if (typeof token !== 'string' || !token || token === this.refusedUserToken) {
      // The provider could not be reached: a token that has not expired yet
      // is still good.
      if (providerFailed && this.userToken && this.userTokenExpiresAt > Math.floor(Date.now() / 1000)) {
        return this.userToken;
      }
      this.userToken = undefined;
      this.userTokenExpiresAt = 0;
      this.startAwaitingUserToken();
      return undefined;
    }

    const tokenUser = this.tokenUser(token);
    const userChanged = !!tokenUser && tokenUser !== this.userId;
    if (userChanged) {
      await this.changeUser(tokenUser!, token);
    } else {
      this.userToken = token;
      this.userTokenExpiresAt = this.tokenExpiry(token);
    }
    this.refusedUserToken = undefined;

    const wasAwaiting = this.awaitingUserToken;
    this.awaitingUserToken = false;
    if (wasAwaiting || userChanged) {
      this.debugLog('User token available');
      this.emit('userTokenReady', { userId: this.userId });
      // Carry on where the SDK stopped: fresh experiments, parked events.
      this.fetchExperiments().catch(() => {});
      this.syncEvents().catch(() => {});
    }
    return token;
  }

  private startAwaitingUserToken(): void {
    if (this.awaitingUserToken || !this.isInitialized) return;
    this.awaitingUserToken = true;
    this.debugLog('Waiting for a user token');
    this.emit('awaitingUserToken', {});
    [...this.awaitingUserTokenListeners].forEach((listener) => {
      try {
        listener();
      } catch (e) {
        this.debugLog('An onAwaitingUserToken listener threw:', e);
      }
    });
  }

  /** Drops the token and any answer the provider still owes. */
  private forgetUserToken(): void {
    this.userToken = undefined;
    this.userTokenExpiresAt = 0;
    this.userTokenGeneration++;
    this.userTokenInFlight = undefined;
  }

  /** `exp` from the token's payload; 0 (refetch next time) if unreadable. */
  private tokenExpiry(token: string): number {
    const exp = tokenClaims(token).exp;
    return typeof exp === 'number' ? exp : 0;
  }

  /** The user a token is for (`sub`), if readable. */
  private tokenUser(token: string): string | undefined {
    const sub = tokenClaims(token).sub;
    return typeof sub === 'string' && sub ? sub : undefined;
  }

  /** The service asked for a pause (HTTP 429): no user call before it ends. */
  private rateLimited(response: Response): void {
    const header = response.headers?.get?.('Retry-After');
    let seconds = header ? Number(header) : NaN;
    if (header && !Number.isFinite(seconds)) {
      seconds = (Date.parse(header) - Date.now()) / 1000;
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      seconds = this.syncConfig.syncIntervalSeconds;
    }
    this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + seconds * 1000);
  }

  // ============================================
  // PRIVATE: ASSIGNMENTS & FLAGS
  // ============================================

  /**
   * The user's assignment for an experiment: the cached one, else the
   * service's. `null` (the caller's default) while there is no user token,
   * and when the service cannot be reached and nothing is cached. A variant
   * is never worked out on the device.
   */
  private async assignmentFor(experimentKey: string): Promise<CachedAssignment | null> {
    const token = await this.ensureUserToken();
    const cached = this.userId ? this.assignments.get(experimentKey) : undefined;
    if (!token) {
      // Waiting. Only when the token could not be fetched (offline, say) is
      // the known user's own assignment still theirs to see.
      return cached && this.tokenProviderFailed ? cached : null;
    }
    if (cached) return cached;
    if (!this.userId || Date.now() < this.rateLimitedUntil) return null;

    // Callers asking for the same experiment share one request.
    let pending = this.assignInFlight.get(experimentKey);
    if (!pending) {
      const request = this.fetchAssignment(experimentKey, token).finally(() => {
        if (this.assignInFlight.get(experimentKey) === request) {
          this.assignInFlight.delete(experimentKey);
        }
      });
      this.assignInFlight.set(experimentKey, request);
      pending = request;
    }
    return pending;
  }

  private async fetchAssignment(
    experimentKey: string,
    token: string
  ): Promise<CachedAssignment | null> {
    const epoch = this.userEpoch;
    const userId = this.userId!;

    try {
      const response = await this.userRequest(
        '/public/assign',
        {
          method: 'POST',
          body: JSON.stringify({
            experimentKey,
            userId,
            ...(Object.keys(this.userAttributes).length > 0
              ? { userAttributes: this.userAttributes }
              : {}),
          }),
        },
        token
      );

      if (!response) return null;
      if (!response.ok) {
        this.debugLog(`Assignment for ${experimentKey} refused: HTTP ${response.status}`);
        return null;
      }

      const body = await response.json();
      const data = (body?.data ?? {}) as Record<string, any>;
      const variantName = (data.variantName as string) || (data.variantKey as string);
      // Another user signed in while the service answered: not theirs.
      if (!variantName || epoch !== this.userEpoch) return null;

      const assignment: CachedAssignment = {
        experimentId: data.experimentId as string,
        variantId: data.variantId as string,
        variantName,
        config: data.config as Record<string, any> | undefined,
        assignedAt: new Date().toISOString(),
        userId,
      };
      await this.cacheAssignment(experimentKey, assignment);

      this.emit('experimentAssigned', {
        experimentKey,
        variantKey: variantName,
        config: data.config,
        // False: the user sees this variant but is not counted in the experiment.
        inExperiment: data.inExperiment !== false,
      });

      return assignment;
    } catch (e) {
      this.debugLog('Failed to get assignment from server:', e);
      return null;
    }
  }

  private async evaluateFlag(featureKey: string): Promise<Record<string, any> | null> {
    if (!this.ready('flag evaluation')) return null;

    const token = await this.ensureUserToken();
    if (!token || !this.userId || Date.now() < this.rateLimitedUntil) return null;
    const epoch = this.userEpoch;

    try {
      const response = await this.userRequest(
        '/public/flag-evaluation',
        {
          method: 'POST',
          body: JSON.stringify({
            flagKey: featureKey,
            userId: this.userId,
            userAttributes: this.userAttributes,
          }),
        },
        token
      );

      if (response?.ok) {
        const data = (await response.json()) as Record<string, any>;
        return epoch === this.userEpoch ? data : null;
      }
    } catch (e) {
      this.debugLog('Failed to evaluate feature flag:', e);
    }

    return null;
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
    if (!this.ready('track')) return;
    this.refreshListIfStale();

    // Get variant ID from cached assignment
    const cached = this.userId ? this.assignments.get(experimentKey) : undefined;
    const variantId = cached?.variantId || '';

    const event: OfflineEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      experimentId: experimentKey,
      variantId,
      // Empty while nobody is signed in: such an event cannot be credited to
      // a user and is dropped when one signs in.
      userId: this.userId || '',
      eventType,
      eventName: options?.eventName || eventType,
      eventValue: options?.eventValue,
      metadata: options?.metadata,
      timestamp: new Date().toISOString(),
      retryCount: 0,
    };

    this.eventQueue.push(event);
    this.trimQueue();
    await this.persistEvents();

    this.debugLog(`Queued ${eventType} event for experiment ${experimentKey}`);

    // Auto-flush if batch is full
    if (this.eventQueue.length >= this.syncConfig.maxBatchSize) {
      this.syncIfPossible();
    }
  }

  private queueLimit(wanted?: number): number {
    return wanted && wanted > 0 ? Math.min(wanted, MAX_QUEUED_EVENTS) : MAX_QUEUED_EVENTS;
  }

  /** Keeps the queue within its limit; the oldest events go first. */
  private trimQueue(): void {
    const over = this.eventQueue.length - this.syncConfig.maxOfflineEvents;
    if (over > 0) this.eventQueue.splice(0, over);
  }

  // ============================================
  // PRIVATE: SYNC
  // ============================================

  private startSyncTimer(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(
      () => this.syncIfPossible(),
      this.syncConfig.syncIntervalSeconds * 1000
    );
  }

  /** The timer's sync: does nothing at all while waiting for a user token. */
  private syncIfPossible(): void {
    if (this.awaitingUserToken || this.eventQueue.length === 0) return;
    this.syncEvents().catch(() => {});
  }

  /** Sends the queue. One run at a time; a second caller gets the same run. */
  private syncEvents(): Promise<void> {
    if (this.syncInFlight) return this.syncInFlight;
    const run = this.runSync().finally(() => {
      if (this.syncInFlight === run) this.syncInFlight = undefined;
    });
    this.syncInFlight = run;
    return run;
  }

  private async runSync(): Promise<void> {
    // What is queued now; events recorded during the run go with the next one.
    let left = this.eventQueue.length;
    while (this.isInitialized && left > 0 && this.eventQueue.length > 0) {
      const now = Date.now();
      if (now < this.syncPausedUntil || now < this.rateLimitedUntil) return;

      // No token: the events stay parked.
      const token = await this.ensureUserToken();
      if (!token) return;

      // The service credits every event in the batch to the token's user,
      // so another user's leftover events cannot be sent under it - they
      // would be credited to the wrong person.
      const userId = this.userId;
      if (!userId) return;
      const before = this.eventQueue.length;
      this.eventQueue = this.eventQueue.filter((e) => e.userId === userId);
      if (this.eventQueue.length !== before) await this.persistEvents();
      if (this.eventQueue.length === 0) return;

      const batch = this.eventQueue.slice(0, Math.min(this.syncConfig.maxBatchSize, left));
      if (!(await this.sendBatch(batch, token))) return;
      left -= batch.length;
    }
  }

  /** Sends one batch. True when the queue can go on to the next one. */
  private async sendBatch(batch: OfflineEvent[], token: string): Promise<boolean> {
    const ids = new Set(batch.map((e) => e.id));
    const done = async () => {
      this.eventQueue = this.eventQueue.filter((e) => !ids.has(e.id));
      await this.persistEvents();
    };
    ids.forEach((id) => this.sendingIds.add(id));

    try {
      const response = await this.userRequest('/public/sync', this.syncBody(batch), token);

      // Waiting for a user token now: the events stay parked.
      if (!response) return false;

      if (response.ok) {
        const result = await response.json().catch(() => ({}));
        // The service has taken the whole batch. Events it could not record
        // (an experiment that no longer exists, another user's event) would
        // fail again, so they are not retried.
        await done();
        this.syncFailures = 0;
        this.eventLimitReported = false;

        this.emit('syncCompleted', {
          synced: (result?.synced as number) || 0,
          failed: (result?.failed as number) || 0,
          pending: this.eventQueue.length,
        });
        return true;
      }

      if (response.status === 429) {
        // Keep the events; rateLimited() has set how long to wait.
        return false;
      }

      // A failing service, or a 401 that is not about the user token (the
      // API key): keep the events and wait longer each time.
      if (response.status >= 500 || response.status === 401) {
        this.pauseSync();
        if (response.status === 401 && this.syncFailures === 1) {
          this.emit('error', { message: `Sync refused: HTTP ${response.status}` });
        }
        return false;
      }

      if (response.status === 403 && (await this.errorCode(response)) === 'event_limit_reached') {
        // The plan's events are used up. Keep the (bounded) queue, try once
        // per interval, and say so once.
        this.syncPausedUntil = Date.now() + this.syncConfig.syncIntervalSeconds * 1000;
        if (!this.eventLimitReported) {
          this.eventLimitReported = true;
          this.emit('error', { message: 'Event limit reached', code: 'event_limit_reached' });
        }
        return false;
      }

      // The request itself is wrong; the same events cannot succeed.
      await done();
      this.emit('error', { message: `Sync refused: HTTP ${response.status}` });
      return true;
    } catch (e) {
      this.pauseSync();
      this.emit('error', { message: `Sync failed: ${e}` });
      return false;
    } finally {
      ids.forEach((id) => this.sendingIds.delete(id));
    }
  }

  private postEvents(batch: OfflineEvent[], token: string): Promise<Response> {
    return this.send('/public/sync', this.syncBody(batch), token);
  }

  private syncBody(batch: OfflineEvent[]): RequestInit {
    return {
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
          timestamp: eventTimeMs(e.timestamp),
          clientEventId: e.id,
        })),
        sdkVersion: `react-native-${SDK_VERSION}`,
      }),
    };
  }

  /** The service or the network failed: wait longer after each failure. */
  private pauseSync(): void {
    this.syncFailures++;
    const wait = Math.min(
      this.syncConfig.syncIntervalSeconds * 1000 * 2 ** (this.syncFailures - 1),
      MAX_BACKOFF_MS
    );
    this.syncPausedUntil = Date.now() + wait;
  }

  // ============================================
  // PRIVATE: EXPERIMENTS
  // ============================================

  /**
   * The experiment list is older than the console allows: ask again in the
   * background. The caller is never kept waiting and goes on with the list it
   * has. Nothing is asked while a load is already running.
   */
  private refreshListIfStale(): void {
    if (this.listLoads > 0) return;
    const now = Date.now();
    if (now < this.listRetryAt) return;
    const age = now - this.listFetchedAt;
    if (age >= 0 && age < this.listCacheSeconds * 1000) return;
    this.fetchExperiments(true).catch(() => {});
  }

  /** `quiet`: a failure is not reported (a refresh the app did not ask for). */
  private async fetchExperiments(quiet = false): Promise<void> {
    let fetched = false;
    this.listLoads++;
    try {
      const response = await this.send(
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

        this.listFetchedAt = Date.now();
        fetched = true;

        const serverConfig = data.config as (Partial<SyncConfig> & { cacheTtlSeconds?: unknown }) | undefined;
        if (serverConfig) {
          const interval = this.syncConfig.syncIntervalSeconds;
          this.listCacheSeconds =
            boundedSeconds(serverConfig.cacheTtlSeconds, LIST_CACHE_BOUNDS_S) ?? this.listCacheSeconds;
          this.syncConfig = {
            ...this.syncConfig,
            // The app's own interval wins; otherwise the console's, inside the bounds.
            syncIntervalSeconds: this.ownFlushInterval
              ? interval
              : boundedSeconds(serverConfig.syncIntervalSeconds, SEND_INTERVAL_BOUNDS_S) ?? interval,
            maxBatchSize: Math.max(
              1,
              Math.min(serverConfig.maxBatchSize ?? this.syncConfig.maxBatchSize, MAX_BATCH_SIZE)
            ),
            maxOfflineEvents: this.queueLimit(
              this.config?.maxQueueSize ?? serverConfig.maxOfflineEvents ?? this.syncConfig.maxOfflineEvents
            ),
          };
          this.trimQueue();
          if (this.isInitialized && this.syncConfig.syncIntervalSeconds !== interval) {
            this.startSyncTimer();
          }
        }

        this.emit('experimentsRefreshed', {
          count: this.cachedExperiments.length,
        });

        this.debugLog(`Fetched ${this.cachedExperiments.length} experiments`);
      }
    } catch (e) {
      this.debugLog('Failed to fetch experiments:', e);
      if (!quiet) {
        this.emit('error', {
          message: `Failed to fetch experiments: ${e}`,
        });
      }
    } finally {
      this.listLoads--;
      this.listRetryAt = fetched ? 0 : Date.now() + LIST_RETRY_MS;
    }
  }

  private onAppStateChange = (state: AppStateStatus): void => {
    if (state === 'background') this.syncIfPossible();
  };
}

export const RiviumAbTesting = new RiviumAbTestingSDK();
export default RiviumAbTesting;

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

declare class RiviumAbTestingSDK {
  // Initialization
  init(config: RiviumAbTestingConfig): Promise<void>;

  // User management
  setUserId(userId: string): Promise<void>;
  getUserId(): Promise<string | null>;
  setUserAttributes(attributes: Record<string, any>): Promise<void>;

  // Experiment assignment
  getVariant(experimentKey: string, defaultVariant?: string): Promise<string>;
  getVariantConfig(experimentKey: string): Promise<Record<string, any> | null>;

  // Core event tracking
  trackView(experimentKey: string): Promise<void>;
  trackClick(experimentKey: string): Promise<void>;
  trackConversion(experimentKey: string, value?: number): Promise<void>;
  trackCustomEvent(
    experimentKey: string,
    eventName: string,
    properties?: Record<string, any>
  ): Promise<void>;

  // Engagement events
  trackScroll(experimentKey: string, depth?: number, properties?: Record<string, any>): Promise<void>;
  trackFormSubmit(experimentKey: string, formName?: string, properties?: Record<string, any>): Promise<void>;
  trackSearch(experimentKey: string, query?: string, properties?: Record<string, any>): Promise<void>;
  trackShare(experimentKey: string, method?: string, properties?: Record<string, any>): Promise<void>;

  // E-commerce events
  trackAddToCart(experimentKey: string, value?: number, productId?: string, properties?: Record<string, any>): Promise<void>;
  trackRemoveFromCart(experimentKey: string, value?: number, productId?: string, properties?: Record<string, any>): Promise<void>;
  trackBeginCheckout(experimentKey: string, value?: number, properties?: Record<string, any>): Promise<void>;
  trackPurchase(experimentKey: string, value: number, transactionId?: string, properties?: Record<string, any>): Promise<void>;

  // Media events
  trackVideoStart(experimentKey: string, videoId?: string, properties?: Record<string, any>): Promise<void>;
  trackVideoComplete(experimentKey: string, videoId?: string, properties?: Record<string, any>): Promise<void>;

  // User auth events
  trackSignUp(experimentKey: string, method?: string, properties?: Record<string, any>): Promise<void>;
  trackLogin(experimentKey: string, method?: string, properties?: Record<string, any>): Promise<void>;
  trackLogout(experimentKey: string, properties?: Record<string, any>): Promise<void>;

  // Generic event tracking
  trackEvent(
    experimentKey: string,
    eventType: EventType,
    eventName?: string,
    value?: number,
    properties?: Record<string, any>
  ): Promise<void>;

  // Experiments
  refreshExperiments(): Promise<void>;
  getExperiments(): Promise<Experiment[]>;

  // Feature flags
  isFeatureEnabled(featureKey: string, defaultValue?: boolean): Promise<boolean>;
  getFeatureValue(featureKey: string, defaultValue?: any): Promise<any>;
  getFeatureFlags(): Promise<FeatureFlag[]>;
  refreshFeatureFlags(): Promise<void>;

  // Flush & lifecycle
  flush(): Promise<void>;
  reset(): Promise<void>;

  // Event listeners
  on(event: RiviumAbTestingEventType, callback: EventCallback): () => void;
  off(event: RiviumAbTestingEventType, callback: EventCallback): void;
}

export const RiviumAbTesting: RiviumAbTestingSDK;
export default RiviumAbTesting;

# Rivium AB Testing React Native SDK

A/B Testing and Feature Flags SDK for React Native with offline-first sync.

[![npm](https://img.shields.io/npm/v/rivium-ab-testing-react-native.svg)](https://www.npmjs.com/package/rivium-ab-testing-react-native)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- A/B testing with automatic variant assignment
- Feature flags with targeting rules and rollout percentages
- Sticky bucketing — users stay in the same variant
- Offline-first event queue with automatic sync
- 17 built-in event types (view, click, conversion, purchase, etc.)
- Pure TypeScript — no native modules required
- Works with React Native 0.60+

## Installation

```bash
npm install rivium-ab-testing-react-native
```

### Peer Dependencies

```bash
npm install @react-native-async-storage/async-storage
```

### iOS Setup

```bash
cd ios && pod install
```

## Quick Start

```typescript
import RiviumAbTesting from 'rivium-ab-testing-react-native';

// 1. Initialize
await RiviumAbTesting.init({
  apiKey: 'rv_live_your_api_key',
  // Your server mints this for the signed-in user (see "User tokens").
  tokenProvider: async () => {
    const res = await fetch('https://your-api.example.com/rivium-token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${yourSessionToken}` },
    });
    return (await res.json()).token;
  },
});

// 2. Set user (call again on login/logout; the last user's data is dropped)
await RiviumAbTesting.setUserId('user-123');

// 3. Get variant
const variant = await RiviumAbTesting.getVariant('checkout-redesign');

// 4. Track conversion
await RiviumAbTesting.trackConversion('checkout-redesign', 49.99);

// 5. Flush events
await RiviumAbTesting.flush();
```

## User tokens

The API key ships inside your app, so anyone can read it. On its own it can't
prove which user a request is for. Your server can: it holds your project's
**server secret** and mints a short-lived token for the signed-in user
(`POST https://auth.rivium.co/users/token`, or `createUserToken()` in
[`rivium-ab-testing-node`](https://www.npmjs.com/package/rivium-ab-testing-node)).
The SDK sends it with every request, and the service takes the user from the
token instead of from the app.

The SDK calls `tokenProvider` when it needs a token, again shortly before the
token expires, and once more if the service reports it expired. Calling
`setUserId` with a different user sends the last user's pending events first,
then drops their variants and token.

A token is **required**: assigning variants, tracking events and
evaluating flags are refused without one (reading the experiment and flag
lists is not, so the app can load them before anyone signs in). The same token works for Rivium Chat and Sync.

**Never put the server secret in the app.**

## A/B Testing

### Get Variant

```typescript
const variant = await RiviumAbTesting.getVariant(
  'experiment-key',
  'control' // fallback if offline and no cache
);
```

### Get Variant Config

```typescript
const config = await RiviumAbTesting.getVariantConfig('experiment-key');
const layout = config?.layout;
const buttonColor = config?.button_color;
```

### List Experiments

```typescript
const experiments = await RiviumAbTesting.getExperiments();
experiments.forEach((exp) => {
  console.log(`${exp.key} [${exp.status}] - ${exp.variants.length} variants`);
});

// Refresh from server
await RiviumAbTesting.refreshExperiments();
```

## Feature Flags

```typescript
// Check if feature is enabled
const darkMode = await RiviumAbTesting.isFeatureEnabled('dark-mode');

// Get feature value (string, number, JSON, etc.)
const maxUpload = await RiviumAbTesting.getFeatureValue('max-upload-size', 10);

// Get all flags
const flags = await RiviumAbTesting.getFeatureFlags();
flags.forEach((flag) => {
  console.log(`${flag.key}: enabled=${flag.enabled}, rollout=${flag.rolloutPercentage}%`);
});

// Refresh flags from server
await RiviumAbTesting.refreshFeatureFlags();
```

## Event Tracking

Track user interactions with 17 built-in event types:

```typescript
// Core events
await RiviumAbTesting.trackView('experiment-key');
await RiviumAbTesting.trackClick('experiment-key');
await RiviumAbTesting.trackConversion('experiment-key', 99.99);

// Custom event
await RiviumAbTesting.trackCustomEvent('experiment-key', 'button_hover', {
  duration_ms: 1500,
  element: 'cta_button',
});

// E-commerce events
await RiviumAbTesting.trackAddToCart('experiment-key', 29.99, 'sku-123', { quantity: 2 });
await RiviumAbTesting.trackPurchase('experiment-key', 59.99, 'txn-456', { currency: 'USD' });
await RiviumAbTesting.trackRemoveFromCart('experiment-key', 29.99, 'sku-123');
await RiviumAbTesting.trackBeginCheckout('experiment-key', 59.99);

// Engagement events
await RiviumAbTesting.trackScroll('experiment-key', 75.0);
await RiviumAbTesting.trackFormSubmit('experiment-key', 'signup');
await RiviumAbTesting.trackSearch('experiment-key', 'shoes');
await RiviumAbTesting.trackShare('experiment-key', 'twitter');

// Media events
await RiviumAbTesting.trackVideoStart('experiment-key', 'vid-001');
await RiviumAbTesting.trackVideoComplete('experiment-key', 'vid-001');

// Auth events
await RiviumAbTesting.trackSignUp('experiment-key', 'google');
await RiviumAbTesting.trackLogin('experiment-key', 'email');
await RiviumAbTesting.trackLogout('experiment-key');
```

### Generic Event Tracking

```typescript
import { EventType } from 'rivium-ab-testing-react-native';

await RiviumAbTesting.trackEvent(
  'experiment-key',
  EventType.CUSTOM,
  'page_load_time',
  2.3,
  { page: '/checkout', cached: false }
);
```

## User Attributes

Set attributes for targeting rules:

```typescript
await RiviumAbTesting.setUserId('user-123');

await RiviumAbTesting.setUserAttributes({
  plan: 'premium',
  country: 'US',
  age: 28,
  platform: 'react-native',
});
```

## Event Listeners

```typescript
// Listen for SDK events
const unsubscribe = RiviumAbTesting.on('experimentAssigned', (event) => {
  console.log('Assigned:', event.data);
});

// Available events:
// 'initialized', 'error', 'experimentAssigned', 'experimentsRefreshed',
// 'featureFlagsRefreshed', 'syncCompleted', 'offlineMode', 'onlineMode'

// Unsubscribe
unsubscribe();
```

## Configuration

```typescript
await RiviumAbTesting.init({
  apiKey: 'rv_live_your_api_key',
  tokenProvider,          // returns a user token minted by your server
  debug: false,           // log to the console (development only)
  flushInterval: 30000,   // Auto-flush interval in ms (default: 30000)
  maxQueueSize: 1000,     // events kept while offline (default: 1000)
});
```

## Lifecycle

```typescript
// Refresh experiments from server
await RiviumAbTesting.refreshExperiments();

// Flush pending events
await RiviumAbTesting.flush();

// Reset all state (clears cache, assignments, events)
await RiviumAbTesting.reset();
```

## API Reference

| Method | Description |
|---|---|
| `init(config)` | Initialize the SDK |
| `setUserId(id)` | Set user ID for assignment |
| `getUserId()` | Get current user ID |
| `setUserAttributes(attrs)` | Set targeting attributes |
| `getVariant(key)` | Get assigned variant |
| `getVariantConfig(key)` | Get variant configuration |
| `isFeatureEnabled(key)` | Check if feature flag is on |
| `getFeatureValue(key)` | Get feature flag value |
| `getFeatureFlags()` | Get all feature flags |
| `refreshFeatureFlags()` | Refresh flags from server |
| `refreshExperiments()` | Refresh experiments from server |
| `getExperiments()` | Get all experiments |
| `trackEvent(key, type, ...)` | Track generic event |
| `flush()` | Force sync pending events |
| `reset()` | Clear all state and cache |
| `on(event, callback)` | Subscribe to SDK events |
| `off(event, callback)` | Unsubscribe from events |

### Event Types

| Type | Constant |
|---|---|
| View | `EventType.VIEW` |
| Click | `EventType.CLICK` |
| Conversion | `EventType.CONVERSION` |
| Custom | `EventType.CUSTOM` |
| Scroll | `EventType.SCROLL` |
| Form Submit | `EventType.FORM_SUBMIT` |
| Search | `EventType.SEARCH` |
| Share | `EventType.SHARE` |
| Add to Cart | `EventType.ADD_TO_CART` |
| Remove from Cart | `EventType.REMOVE_FROM_CART` |
| Begin Checkout | `EventType.BEGIN_CHECKOUT` |
| Purchase | `EventType.PURCHASE` |
| Video Start | `EventType.VIDEO_START` |
| Video Complete | `EventType.VIDEO_COMPLETE` |
| Sign Up | `EventType.SIGN_UP` |
| Login | `EventType.LOGIN` |
| Logout | `EventType.LOGOUT` |

## Platform Support

- iOS 12.0+
- Android API 21+

## Documentation

- [Rivium Console](https://console.rivium.co)
- [React Native SDK Docs](https://console.rivium.co/dashboard/rivium-abtest/docs/react-native)

## License

MIT

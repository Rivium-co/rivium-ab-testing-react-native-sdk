import React, { useState, useCallback, useRef } from 'react';
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
} from 'react-native';
import RiviumAbTesting, { EventType } from 'rivium-ab-testing-react-native';

// ============================================
// CONFIGURATION
// ============================================
const API_KEY = 'YOUR_API_KEY_HERE';
const TEST_USER_ID = 'test-user-rn-001';
const TEST_EXPERIMENT_KEY = 'checkout-flow-test';
const TEST_FEATURE_FLAG = 'dark_mode';
const EXPERIMENT_KEYS = ['checkout-flow-test', 'pricing-page-test'];
const FLAG_KEYS = ['dark_mode', 'Onboarding Flow', 'Dark Mode Settings', 'maintenance_mode', 'premium_banner', 'checkout_flow'];

export default function App() {
  const [logs, setLogs] = useState<string[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [currentVariant, setCurrentVariant] = useState<string | null>(null);
  const logRef = useRef<FlatList>(null);

  const log = useCallback((message: string) => {
    const timestamp = new Date().toISOString().substring(11, 19);
    setLogs((prev) => [`[${timestamp}] ${message}`, ...prev].slice(0, 100));
  }, []);

  // ============================================
  // 1. INITIALIZATION
  // ============================================

  const initSDK = async () => {
    log('Initializing SDK...');
    try {
      await RiviumAbTesting.init({
        apiKey: API_KEY,
        debug: true,
        flushInterval: 10000, // 10 seconds for testing
        maxQueueSize: 50,
      });

      RiviumAbTesting.on('experimentAssigned', (event) => {
        log(`Event: experimentAssigned - ${JSON.stringify(event.data)}`);
      });
      RiviumAbTesting.on('experimentsRefreshed', (event) => {
        log(`Event: experimentsRefreshed - ${JSON.stringify(event.data)}`);
      });
      RiviumAbTesting.on('featureFlagsRefreshed', (event) => {
        log(`Event: featureFlagsRefreshed`);
      });
      RiviumAbTesting.on('syncCompleted', (event) => {
        log(`Event: syncCompleted - ${JSON.stringify(event.data)}`);
      });
      RiviumAbTesting.on('error', (event) => {
        log(`Event: error - ${JSON.stringify(event.data)}`);
      });

      setIsInitialized(true);
      log('SDK initialized successfully');
    } catch (e: any) {
      log(`Init failed: ${e.message}`);
    }
  };

  // ============================================
  // 2. USER MANAGEMENT
  // ============================================

  const setUser = async () => {
    try {
      await RiviumAbTesting.setUserId(TEST_USER_ID);
      log(`User ID set: ${TEST_USER_ID}`);

      await RiviumAbTesting.setUserAttributes({
        plan: 'premium',
        country: 'US',
        app_version: '2.1.0',
        platform: 'react-native',
      });
      log('User attributes set');
    } catch (e: any) {
      log(`Set user failed: ${e.message}`);
    }
  };

  // ============================================
  // 3. EXPERIMENT ASSIGNMENT
  // ============================================

  const getVariant = async () => {
    try {
      const variant = await RiviumAbTesting.getVariant(
        TEST_EXPERIMENT_KEY,
        'control'
      );
      setCurrentVariant(variant);
      log(`Assigned variant: ${variant}`);
    } catch (e: any) {
      log(`Get variant failed: ${e.message}`);
    }
  };

  const getVariantConfig = async () => {
    try {
      const config = await RiviumAbTesting.getVariantConfig(
        TEST_EXPERIMENT_KEY
      );
      log(`Variant config: ${JSON.stringify(config)}`);
    } catch (e: any) {
      log(`Get variant config failed: ${e.message}`);
    }
  };

  const getExperiments = async () => {
    try {
      const experiments = await RiviumAbTesting.getExperiments();
      log(`Experiments (${experiments.length}):`);
      experiments.forEach((exp) => {
        log(
          `  - ${exp.name} [${exp.status}] (${exp.variants.length} variants, ${exp.trafficAllocation}% traffic)`
        );
      });
    } catch (e: any) {
      log(`Get experiments failed: ${e.message}`);
    }
  };

  // ============================================
  // 4. CORE EVENT TRACKING
  // ============================================

  const trackView = async () => {
    try {
      await RiviumAbTesting.trackView(TEST_EXPERIMENT_KEY);
      log('Tracked: VIEW');
    } catch (e: any) {
      log(`Track view failed: ${e.message}`);
    }
  };

  const trackClick = async () => {
    try {
      await RiviumAbTesting.trackClick(TEST_EXPERIMENT_KEY);
      log('Tracked: CLICK');
    } catch (e: any) {
      log(`Track click failed: ${e.message}`);
    }
  };

  const trackConversion = async () => {
    try {
      await RiviumAbTesting.trackConversion(TEST_EXPERIMENT_KEY, 29.99);
      log('Tracked: CONVERSION (value: 29.99)');
    } catch (e: any) {
      log(`Track conversion failed: ${e.message}`);
    }
  };

  const trackCustom = async () => {
    try {
      await RiviumAbTesting.trackCustomEvent(
        TEST_EXPERIMENT_KEY,
        'button_hover',
        { duration_ms: 1500, element: 'cta_button' }
      );
      log('Tracked: CUSTOM (button_hover)');
    } catch (e: any) {
      log(`Track custom event failed: ${e.message}`);
    }
  };

  // ============================================
  // 5. ENGAGEMENT EVENTS
  // ============================================

  const trackEngagementEvents = async () => {
    try {
      await RiviumAbTesting.trackScroll(TEST_EXPERIMENT_KEY, 75.0, {
        page: 'product_detail',
      });
      log('Tracked: SCROLL (depth: 75%)');

      await RiviumAbTesting.trackFormSubmit(
        TEST_EXPERIMENT_KEY,
        'checkout_form',
        { fields_count: 5 }
      );
      log('Tracked: FORM_SUBMIT (checkout_form)');

      await RiviumAbTesting.trackSearch(TEST_EXPERIMENT_KEY, 'react native', {
        results_count: 42,
      });
      log('Tracked: SEARCH (react native)');

      await RiviumAbTesting.trackShare(TEST_EXPERIMENT_KEY, 'twitter', {
        content_id: 'article-123',
      });
      log('Tracked: SHARE (twitter)');
    } catch (e: any) {
      log(`Engagement tracking failed: ${e.message}`);
    }
  };

  // ============================================
  // 6. E-COMMERCE EVENTS
  // ============================================

  const trackEcommerceEvents = async () => {
    try {
      await RiviumAbTesting.trackAddToCart(
        TEST_EXPERIMENT_KEY,
        49.99,
        'prod-456',
        { quantity: 2, category: 'electronics' }
      );
      log('Tracked: ADD_TO_CART (prod-456, $49.99)');

      await RiviumAbTesting.trackRemoveFromCart(
        TEST_EXPERIMENT_KEY,
        49.99,
        'prod-456'
      );
      log('Tracked: REMOVE_FROM_CART (prod-456)');

      await RiviumAbTesting.trackBeginCheckout(
        TEST_EXPERIMENT_KEY,
        149.97,
        { items_count: 3, coupon: 'SAVE10' }
      );
      log('Tracked: BEGIN_CHECKOUT ($149.97)');

      await RiviumAbTesting.trackPurchase(
        TEST_EXPERIMENT_KEY,
        134.97,
        'txn-789',
        {
          items_count: 3,
          payment_method: 'credit_card',
          currency: 'USD',
        }
      );
      log('Tracked: PURCHASE (txn-789, $134.97)');
    } catch (e: any) {
      log(`E-commerce tracking failed: ${e.message}`);
    }
  };

  // ============================================
  // 7. MEDIA EVENTS
  // ============================================

  const trackMediaEvents = async () => {
    try {
      await RiviumAbTesting.trackVideoStart(
        TEST_EXPERIMENT_KEY,
        'video-onboarding-01',
        { duration: 120, quality: '1080p' }
      );
      log('Tracked: VIDEO_START (video-onboarding-01)');

      await RiviumAbTesting.trackVideoComplete(
        TEST_EXPERIMENT_KEY,
        'video-onboarding-01',
        { watch_time: 118 }
      );
      log('Tracked: VIDEO_COMPLETE (video-onboarding-01)');
    } catch (e: any) {
      log(`Media tracking failed: ${e.message}`);
    }
  };

  // ============================================
  // 8. USER AUTH EVENTS
  // ============================================

  const trackAuthEvents = async () => {
    try {
      await RiviumAbTesting.trackSignUp(TEST_EXPERIMENT_KEY, 'google', {
        referral: 'organic',
      });
      log('Tracked: SIGN_UP (google)');

      await RiviumAbTesting.trackLogin(TEST_EXPERIMENT_KEY, 'email', {
        remember_me: true,
      });
      log('Tracked: LOGIN (email)');

      await RiviumAbTesting.trackLogout(TEST_EXPERIMENT_KEY, {
        session_duration: 3600,
      });
      log('Tracked: LOGOUT');
    } catch (e: any) {
      log(`Auth tracking failed: ${e.message}`);
    }
  };

  // ============================================
  // 9. GENERIC TRACKING
  // ============================================

  const trackGenericEvent = async () => {
    try {
      await RiviumAbTesting.trackEvent(
        TEST_EXPERIMENT_KEY,
        EventType.CUSTOM,
        'page_load_time',
        2.3,
        { page: '/checkout', cached: false }
      );
      log('Tracked: GENERIC (page_load_time, 2.3s)');
    } catch (e: any) {
      log(`Generic tracking failed: ${e.message}`);
    }
  };

  // ============================================
  // 10. FEATURE FLAGS
  // ============================================

  const testFeatureFlags = async () => {
    try {
      for (const key of FLAG_KEYS) {
        const enabled = await RiviumAbTesting.isFeatureEnabled(key, false);
        log(`Flag '${key}': ${enabled ? 'ENABLED' : 'DISABLED'}`);
      }

      const value = await RiviumAbTesting.getFeatureValue(
        'Dark Mode Settings',
        'default'
      );
      log(`Flag value Dark Mode Settings: ${JSON.stringify(value)}`);

      const flags = await RiviumAbTesting.getFeatureFlags();
      log(`Feature flags: ${flags.length}`);
      flags.forEach((flag) => {
        log(
          `  - ${flag.key} [${flag.enabled ? 'ON' : 'OFF'}] rollout: ${flag.rolloutPercentage}%`
        );
      });

      await RiviumAbTesting.refreshFeatureFlags();
      log('Feature flags refreshed');
    } catch (e: any) {
      log(`Feature flags test failed: ${e.message}`);
    }
  };

  // ============================================
  // 11. SYNC & LIFECYCLE
  // ============================================

  const flush = async () => {
    try {
      await RiviumAbTesting.flush();
      log('Flush completed');
    } catch (e: any) {
      log(`Flush failed: ${e.message}`);
    }
  };

  const refreshExperiments = async () => {
    try {
      await RiviumAbTesting.refreshExperiments();
      log('Experiments refreshed');
    } catch (e: any) {
      log(`Refresh failed: ${e.message}`);
    }
  };

  const resetSDK = async () => {
    try {
      await RiviumAbTesting.reset();
      setIsInitialized(false);
      setCurrentVariant(null);
      log('SDK reset');
    } catch (e: any) {
      log(`Reset failed: ${e.message}`);
    }
  };

  const runAllTests = async () => {
    log('=== RUNNING ALL TESTS ===');
    await initSDK();
    await setUser();
    await getVariant();
    await getVariantConfig();
    await getExperiments();
    await trackView();
    await trackClick();
    await trackConversion();
    await trackCustom();
    await trackEngagementEvents();
    await trackEcommerceEvents();
    await trackMediaEvents();
    await trackAuthEvents();
    await trackGenericEvent();
    await testFeatureFlags();
    await flush();
    log('=== ALL TESTS COMPLETE ===');
  };

  // ============================================
  // UI
  // ============================================

  const renderButton = (
    label: string,
    onPress: () => void,
    color: string,
    disabled = false
  ) => (
    <TouchableOpacity
      key={label}
      style={[
        styles.button,
        { backgroundColor: color },
        disabled && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );

  const renderSection = (title: string, buttons: React.ReactNode[]) => (
    <View key={title} style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.buttonRow}>{buttons}</View>
    </View>
  );

  const notReady = !isInitialized;

  return (
    <SafeAreaView style={styles.container}>
      {/* Status bar */}
      <View
        style={[
          styles.statusBar,
          { backgroundColor: isInitialized ? '#f0fdf4' : '#fef2f2' },
        ]}
      >
        <Text
          style={{
            color: isInitialized ? '#16a34a' : '#dc2626',
            fontWeight: 'bold',
          }}
        >
          {isInitialized ? '● SDK Initialized' : '○ SDK Not Initialized'}
        </Text>
        {currentVariant && (
          <View style={styles.variantChip}>
            <Text style={styles.variantText}>Variant: {currentVariant}</Text>
          </View>
        )}
      </View>

      {/* Buttons */}
      <ScrollView style={styles.buttonsContainer}>
        {renderSection('Setup', [
          renderButton('Run All Tests', runAllTests, '#7c3aed'),
          renderButton('Init SDK', initSDK, '#2563eb'),
          renderButton('Set User', setUser, '#2563eb', notReady),
        ])}
        {renderSection('Experiments', [
          renderButton('Get Variant', getVariant, '#0d9488', notReady),
          renderButton('Get Config', getVariantConfig, '#0d9488', notReady),
          renderButton('Get Experiments', getExperiments, '#0d9488', notReady),
          renderButton('Refresh', refreshExperiments, '#0d9488', notReady),
        ])}
        {renderSection('Core Events', [
          renderButton('View', trackView, '#ea580c', notReady),
          renderButton('Click', trackClick, '#ea580c', notReady),
          renderButton('Conversion', trackConversion, '#ea580c', notReady),
          renderButton('Custom', trackCustom, '#ea580c', notReady),
          renderButton('Generic', trackGenericEvent, '#ea580c', notReady),
        ])}
        {renderSection('Specialized Events', [
          renderButton('Engagement', trackEngagementEvents, '#4f46e5', notReady),
          renderButton('E-Commerce', trackEcommerceEvents, '#4f46e5', notReady),
          renderButton('Media', trackMediaEvents, '#4f46e5', notReady),
          renderButton('Auth', trackAuthEvents, '#4f46e5', notReady),
        ])}
        {renderSection('Feature Flags', [
          renderButton('Test Flags', testFeatureFlags, '#16a34a', notReady),
        ])}
        {renderSection('Lifecycle', [
          renderButton('Flush', flush, '#d97706', notReady),
          renderButton('Reset', resetSDK, '#dc2626'),
        ])}
      </ScrollView>

      {/* Log panel */}
      <View style={styles.logPanel}>
        <View style={styles.logHeader}>
          <Text style={styles.logTitle}>Logs ({logs.length})</Text>
          <TouchableOpacity onPress={() => setLogs([])}>
            <Text style={styles.clearButton}>Clear</Text>
          </TouchableOpacity>
        </View>
        <FlatList
          ref={logRef}
          data={logs}
          keyExtractor={(_, i) => `${i}`}
          renderItem={({ item }) => (
            <Text
              style={[
                styles.logText,
                item.includes('failed') || item.includes('Error')
                  ? styles.logError
                  : item.includes('Tracked:')
                  ? styles.logSuccess
                  : null,
              ]}
            >
              {item}
            </Text>
          )}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 12,
  },
  variantChip: {
    backgroundColor: '#f3e8ff',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  variantText: { color: '#7c3aed', fontSize: 12, fontWeight: '600' },
  buttonsContainer: { flex: 1, padding: 12 },
  section: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#6b7280',
    marginBottom: 6,
  },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  logPanel: { height: 200, backgroundColor: '#111827' },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 8,
  },
  logTitle: { color: '#9ca3af', fontWeight: 'bold', fontSize: 12 },
  clearButton: { color: '#9ca3af', fontSize: 12 },
  logText: { color: '#d1d5db', fontSize: 11, fontFamily: 'monospace', paddingHorizontal: 8 },
  logError: { color: '#f87171' },
  logSuccess: { color: '#4ade80' },
});

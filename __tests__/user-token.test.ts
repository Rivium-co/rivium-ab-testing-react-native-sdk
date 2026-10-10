import { FakeService, assigned, unauthorized, tokenFor, tokenUser, settle, platform, loadSdk, stopTimers } from './helpers';

type Sdk = ReturnType<typeof loadSdk>;

describe('waiting for a user token', () => {
  let service: FakeService;
  let sdk: Sdk;
  let errors: unknown[];

  beforeEach(() => {
    platform.install();
    service = new FakeService();
    service.install();
    service.routes['/public/assign'] = assigned('blue');
    sdk = loadSdk();
    errors = [];
    sdk.on('error', (e) => errors.push(e.data));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await sdk.reset();
    stopTimers();
  });

  describe('with no token at all', () => {
    it('waits: defaults, parked events, no user call, no error', async () => {
      const onAwaiting = jest.fn();
      sdk.onAwaitingUserToken(onAwaiting);

      await sdk.init({ apiKey: 'rv_test_key' });

      expect(sdk.isAwaitingUserToken).toBe(true);
      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await expect(sdk.getVariant('checkout')).resolves.toBe('control');
      await expect(sdk.getVariantConfig('checkout')).resolves.toBeNull();
      await expect(sdk.isFeatureEnabled('dark-mode', true)).resolves.toBe(true);
      await expect(sdk.getFeatureValue('limit', 10)).resolves.toBe(10);
      await expect(sdk.trackView('checkout')).resolves.toBeUndefined();
      await sdk.flush();
      await settle();

      expect(service.userCalls()).toEqual([]);
      expect(platform.stored('events')).toHaveLength(1);
      expect(platform.storedAssignments()).toEqual([]);
      expect(errors).toEqual([]);
      expect(onAwaiting).toHaveBeenCalledTimes(1);
    });

    it('does the same with a user id but no token', async () => {
      await sdk.init({ apiKey: 'rv_test_key' });
      await sdk.setUserId('user-1');

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await sdk.trackClick('checkout');
      await sdk.flush();

      expect(service.userCalls()).toEqual([]);
      expect(platform.stored('events')).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    it('continues when the app sets a token', async () => {
      await sdk.init({ apiKey: 'rv_test_key' });
      await sdk.setUserId('user-1');
      await sdk.trackView('checkout');
      const ready = jest.fn();
      sdk.on('userTokenReady', ready);

      const token = tokenFor('user-1');
      await sdk.setUserToken(token);
      await sdk.flush();

      expect(sdk.isAwaitingUserToken).toBe(false);
      expect(ready).toHaveBeenCalledTimes(1);
      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('blue');
      expect(service.to('/public/assign')[0].token).toBe(token);
      expect(service.sentEvents()).toEqual([expect.objectContaining({ userId: 'user-1', token })]);
      expect(platform.stored('events')).toEqual([]);
    });
  });

  describe('with a tokenProvider', () => {
    it('treats null, undefined, an empty string and a throw as "nobody signed in"', async () => {
      for (const answer of [null, undefined, '', new Error('offline')]) {
        platform.install();
        service.calls = [];
        sdk = loadSdk();
        const failures: unknown[] = [];
        sdk.on('error', (e) => failures.push(e.data));
        const tokenProvider = jest.fn(async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        });

        await sdk.init({ apiKey: 'rv_test_key', tokenProvider });
        await sdk.setUserId('user-1');

        expect(sdk.isAwaitingUserToken).toBe(true);
        await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
        await sdk.trackView('checkout');
        await settle();
        expect(service.userCalls()).toEqual([]);
        expect(failures).toEqual([]);
        await sdk.reset();
      }
    });

    it('fetches the assignment and sends parked events once the provider has a token', async () => {
      let token: string | null = null;
      const tokenProvider = jest.fn(async () => token);
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider });
      await sdk.setUserId('user-1');
      await sdk.trackView('checkout');
      await sdk.trackClick('checkout');
      expect(sdk.isAwaitingUserToken).toBe(true);
      expect(service.userCalls()).toEqual([]);

      token = tokenFor('user-1');
      await sdk.refreshUserToken();
      await sdk.flush();

      expect(sdk.isAwaitingUserToken).toBe(false);
      await expect(sdk.getVariant('checkout')).resolves.toBe('blue');
      expect(service.to('/public/assign')).toHaveLength(1);
      expect(service.sentEvents()).toHaveLength(2);
      expect(service.sentEvents().every((e) => e.token === token && e.userId === 'user-1')).toBe(true);
    });

    it('takes the user from the token when no user id was set', async () => {
      const token = tokenFor('user-7');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider: async () => token });

      await expect(sdk.getVariant('checkout')).resolves.toBe('blue');
      await expect(sdk.getUserId()).resolves.toBe('user-7');
      expect(service.to('/public/assign')[0].body.userId).toBe('user-7');
    });

    it('does not ask the provider on every call while waiting', async () => {
      const tokenProvider = jest.fn(async () => null);
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider });
      await settle();
      const asked = tokenProvider.mock.calls.length;

      for (let i = 0; i < 20; i++) {
        await sdk.getVariant('checkout');
        await sdk.trackView('checkout');
        await sdk.isFeatureEnabled('dark-mode');
      }
      await sdk.flush();
      await settle();

      expect(tokenProvider.mock.calls.length).toBe(asked);
      expect(service.userCalls()).toEqual([]);
    });

    it('reports the waiting state once per time it starts waiting', async () => {
      let token: string | null = null;
      const onAwaiting = jest.fn();
      const events = jest.fn();
      sdk.onAwaitingUserToken(onAwaiting);
      sdk.on('awaitingUserToken', events);

      await sdk.init({ apiKey: 'rv_test_key', tokenProvider: async () => token });
      await sdk.setUserId('user-1');
      await sdk.getVariant('checkout');
      await sdk.refreshUserToken();
      expect(onAwaiting).toHaveBeenCalledTimes(1);

      token = tokenFor('user-1');
      await sdk.refreshUserToken();
      expect(sdk.isAwaitingUserToken).toBe(false);

      token = null;
      await sdk.refreshUserToken();
      expect(sdk.isAwaitingUserToken).toBe(true);
      expect(onAwaiting).toHaveBeenCalledTimes(2);
      expect(events).toHaveBeenCalledTimes(2);
    });
  });

  describe('events recorded before sign-in', () => {
    it('drops events recorded for nobody and keeps the ones recorded for the user who signs in', async () => {
      let token: string | null = null;
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider: async () => token });
      await sdk.trackView('checkout'); // nobody signed in
      await sdk.setUserId('user-1');
      await sdk.trackClick('checkout'); // recorded for user-1
      await sdk.setUserId('user-2');
      await sdk.trackClick('checkout'); // recorded for user-2

      token = tokenFor('user-2');
      await sdk.refreshUserToken();
      await sdk.flush();

      expect(service.sentEvents()).toEqual([expect.objectContaining({ userId: 'user-2', token })]);
      expect(platform.stored('events')).toEqual([]);
    });
  });

  describe('when the service refuses the token', () => {
    it('token_required: waits, no retry, no error, nothing cached', async () => {
      const token = tokenFor('user-1');
      const tokenProvider = jest.fn(async () => token);
      service.routes['/public/assign'] = unauthorized('token_required');
      service.routes['/public/sync'] = unauthorized('token_required');
      service.routes['/public/flag-evaluation'] = unauthorized('token_required');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider });
      await sdk.setUserId('user-1');

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      expect(sdk.isAwaitingUserToken).toBe(true);
      expect(service.to('/public/assign')).toHaveLength(1);

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await expect(sdk.isFeatureEnabled('dark-mode')).resolves.toBe(false);
      await sdk.trackView('checkout');
      await sdk.flush();
      await sdk.refreshUserToken(); // the provider still has only the refused token
      await sdk.getVariant('checkout');
      await settle();

      expect(service.userCalls()).toHaveLength(1);
      expect(platform.storedAssignments()).toEqual([]);
      expect(platform.stored('events')).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    it('token_required on sync keeps the events', async () => {
      const token = tokenFor('user-1');
      service.routes['/public/sync'] = unauthorized('token_required');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider: async () => token });
      await sdk.setUserId('user-1');
      await sdk.trackView('checkout');

      await sdk.flush();
      await sdk.flush();

      expect(service.to('/public/sync')).toHaveLength(1);
      expect(sdk.isAwaitingUserToken).toBe(true);
      expect(platform.stored('events')).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    it('token_expired: one refresh, one retry', async () => {
      const first = tokenFor('user-1');
      const second = tokenFor('user-1');
      const tokenProvider = jest.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
      service.routes['/public/assign'] = (call) =>
        call.token === first ? unauthorized('token_expired') : assigned('blue');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider });
      await sdk.setUserId('user-1');

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('blue');

      expect(tokenProvider).toHaveBeenCalledTimes(2);
      expect(service.to('/public/assign').map((c) => c.token)).toEqual([first, second]);
      expect(sdk.isAwaitingUserToken).toBe(false);
      expect(errors).toEqual([]);
    });

    it('token_expired on several calls at once shares one refresh', async () => {
      const first = tokenFor('user-1');
      const second = tokenFor('user-1');
      const tokenProvider = jest.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
      service.routes['/public/assign'] = (call) =>
        call.token === first ? unauthorized('token_expired') : assigned('blue');
      service.routes['/public/flag-evaluation'] = (call) =>
        call.token === first ? unauthorized('token_expired') : { body: { enabled: true, value: 5 } };
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider });
      await sdk.setUserId('user-1');

      const results = await Promise.all([
        sdk.getVariant('checkout'),
        sdk.getVariant('pricing'),
        sdk.isFeatureEnabled('dark-mode'),
      ]);

      expect(results).toEqual(['blue', 'blue', true]);
      expect(tokenProvider).toHaveBeenCalledTimes(2);
    });

    it('token_expired and the refresh has no token: waits, no loop', async () => {
      const first = tokenFor('user-1');
      const tokenProvider = jest.fn().mockResolvedValueOnce(first).mockResolvedValue(null);
      service.routes['/public/assign'] = unauthorized('token_expired');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider });
      await sdk.setUserId('user-1');

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await settle();

      expect(sdk.isAwaitingUserToken).toBe(true);
      expect(service.to('/public/assign')).toHaveLength(1);
      expect(tokenProvider).toHaveBeenCalledTimes(2);
      expect(errors).toEqual([]);
    });

    it('token_expired and the provider returns the same token again: waits, no loop', async () => {
      const token = tokenFor('user-1');
      const tokenProvider = jest.fn(async () => token);
      service.routes['/public/assign'] = unauthorized('token_expired');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider });
      await sdk.setUserId('user-1');

      await sdk.getVariant('checkout');
      await sdk.getVariant('checkout');
      await sdk.getVariant('checkout');

      expect(sdk.isAwaitingUserToken).toBe(true);
      expect(service.to('/public/assign')).toHaveLength(1);
    });

    it('an expired static token: waits until the app sets a new one', async () => {
      const old = tokenFor('user-1');
      service.routes['/public/assign'] = (call) => (call.token === old ? unauthorized('token_expired') : assigned('blue'));
      await sdk.init({ apiKey: 'rv_test_key', userToken: old });

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      expect(sdk.isAwaitingUserToken).toBe(true);

      await sdk.setUserToken(tokenFor('user-1'));
      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('blue');
    });

    it('token_invalid: no retry, reported once', async () => {
      const token = tokenFor('user-1');
      const tokenProvider = jest.fn(async () => token);
      service.routes['/public/assign'] = unauthorized('token_invalid');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider });
      await sdk.setUserId('user-1');

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await sdk.getVariant('checkout');
      await sdk.refreshUserToken();
      await sdk.getVariant('checkout');

      expect(service.to('/public/assign')).toHaveLength(1);
      expect(errors).toEqual([{ message: 'User token rejected: token_invalid', code: 'token_invalid' }]);
      expect(sdk.isAwaitingUserToken).toBe(true);
    });
  });

  describe('when the user changes', () => {
    it('never sends one user\'s events under another user\'s token', async () => {
      const tokens: Record<string, string> = { a: tokenFor('user-a'), b: tokenFor('user-b') };
      let current = 'a';
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider: async () => tokens[current] });
      await sdk.setUserId('user-a');
      await sdk.getVariant('checkout');
      await sdk.trackView('checkout');
      await sdk.trackClick('checkout');

      // The app's provider already answers for B when the SDK is told.
      current = 'b';
      await sdk.setUserId('user-b');
      await sdk.trackConversion('checkout', 5);
      await sdk.flush();
      await settle();

      const sent = service.sentEvents();
      expect(sent).toHaveLength(3);
      for (const event of sent) {
        expect(tokenUser(event.token)).toBe(event.userId);
      }
      expect(platform.stored('events')).toEqual([]);
    });

    it('drops the last user\'s events when their token is gone', async () => {
      let token: string | null = null;
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider: async () => token });
      await sdk.setUserId('user-a');
      await sdk.trackView('checkout'); // parked: A never had a token

      token = tokenFor('user-b');
      await sdk.setUserId('user-b');
      await sdk.flush();
      await settle();

      expect(service.sentEvents()).toEqual([]);
      expect(platform.stored('events')).toEqual([]);
    });

    it('clears the last user\'s variants and attributes before the next user asks', async () => {
      const tokens: Record<string, string> = { a: tokenFor('user-a'), b: tokenFor('user-b') };
      let current = 'a';
      service.routes['/public/assign'] = (call) => assigned(tokenUser(call.token) === 'user-a' ? 'for-a' : 'for-b');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider: async () => tokens[current] });
      await sdk.setUserId('user-a');
      await sdk.setUserAttributes({ plan: 'premium' });
      await expect(sdk.getVariant('checkout')).resolves.toBe('for-a');
      expect(platform.storedAssignments()).toHaveLength(1);

      current = 'b';
      await sdk.setUserId('user-b');
      expect(platform.storedAssignments()).toEqual([]);

      await expect(sdk.getVariant('checkout')).resolves.toBe('for-b');
      const calls = service.to('/public/assign');
      expect(calls).toHaveLength(2);
      expect(calls[1].body).toEqual({ experimentKey: 'checkout', userId: 'user-b' });
      expect(tokenUser(calls[1].token)).toBe('user-b');
    });

    it('follows the token when it is for another user', async () => {
      const tokens: Record<string, string> = { a: tokenFor('user-a'), b: tokenFor('user-b') };
      let current = 'a';
      service.routes['/public/assign'] = (call) => assigned(tokenUser(call.token) === 'user-a' ? 'for-a' : 'for-b');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider: async () => tokens[current] });
      await expect(sdk.getVariant('checkout')).resolves.toBe('for-a');
      await sdk.trackView('checkout');
      const ready = jest.fn();
      sdk.on('userTokenReady', ready);

      current = 'b';
      await sdk.refreshUserToken();
      await sdk.flush();
      await settle();

      await expect(sdk.getUserId()).resolves.toBe('user-b');
      await expect(sdk.getVariant('checkout')).resolves.toBe('for-b');
      expect(ready).toHaveBeenCalledTimes(1);
      for (const event of service.sentEvents()) {
        expect(tokenUser(event.token)).toBe(event.userId);
      }
    });

    it('an answer for the last user is not kept for the next one', async () => {
      const tokens: Record<string, string> = { a: tokenFor('user-a'), b: tokenFor('user-b') };
      let current = 'a';
      let release: (reply: ReturnType<typeof assigned>) => void = () => {};
      service.routes['/public/assign'] = (call) =>
        tokenUser(call.token) === 'user-a'
          ? new Promise((resolve) => {
              release = resolve;
            })
          : assigned('for-b');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider: async () => tokens[current] });
      await sdk.setUserId('user-a');
      const slow = sdk.getVariant('checkout', 'fallback');
      await settle();

      current = 'b';
      await sdk.setUserId('user-b');
      release(assigned('for-a'));

      await expect(slow).resolves.toBe('fallback');
      await expect(sdk.getVariant('checkout')).resolves.toBe('for-b');
    });

    it('setUserToken(null) and clearUserId() sign the user out and leave nothing behind', async () => {
      for (const signOut of [() => sdk.setUserToken(null), () => sdk.clearUserId()]) {
        platform.install();
        service.calls = [];
        sdk = loadSdk();
        const token = tokenFor('user-a');
        await sdk.init({ apiKey: 'rv_test_key', userToken: token });
        await sdk.getVariant('checkout');
        await sdk.trackView('checkout');
        expect(platform.storedAssignments()).toHaveLength(1);

        await signOut();
        await sdk.flush();
        await settle();

        expect(sdk.isAwaitingUserToken).toBe(true);
        await expect(sdk.getUserId()).resolves.toBeNull();
        expect(platform.storedAssignments()).toEqual([]);
        expect(platform.stored('events')).toEqual([]);
        expect(platform.stored('user_id')).toBeNull();
        await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
        // The user's last event went out under their own token, or not at all.
        for (const event of service.sentEvents()) {
          expect(event.token).toBe(token);
        }
        await sdk.reset();
      }
    });

    it('a stored user from the last visit is replaced by the token\'s user', async () => {
      platform.store('user_id', 'user-a');
      platform.store('assignment_checkout', {
        experimentId: 'exp-1',
        variantId: 'id-old',
        variantName: 'for-a',
        assignedAt: new Date().toISOString(),
      });
      platform.store('events', [
        { id: 'evt_old', experimentId: 'checkout', variantId: '', userId: 'user-a', eventType: 'view', eventName: 'view', timestamp: new Date().toISOString(), retryCount: 0 },
      ]);
      const token = tokenFor('user-b');

      await sdk.init({ apiKey: 'rv_test_key', userToken: token });
      await expect(sdk.getVariant('checkout')).resolves.toBe('blue');
      await sdk.flush();
      await settle();

      expect(service.sentEvents()).toEqual([]);
      expect(platform.stored('user_id')).toBe('user-b');
    });
  });

  describe('assignments', () => {
    it('accepts 200 and 201', async () => {
      for (const status of [200, 201]) {
        platform.install();
        sdk = loadSdk();
        service.routes['/public/assign'] = { ...assigned('blue'), status };
        service.routes['/public/flag-evaluation'] = { status, body: { enabled: true, value: 'on' } };
        await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1') });

        await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('blue');
        await expect(sdk.getVariantConfig('checkout')).resolves.toEqual({ color: 'blue' });
        await expect(sdk.isFeatureEnabled('dark-mode')).resolves.toBe(true);
        await expect(sdk.getFeatureValue('dark-mode')).resolves.toBe('on');
        await sdk.reset();
      }
    });

    it('a user who is not in the experiment gets the service\'s variant without an error', async () => {
      service.routes['/public/assign'] = assigned('control', { isControl: true, inExperiment: false });
      await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1') });

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('control');
      expect(errors).toEqual([]);
    });

    it('never works out a variant on the device', async () => {
      service.routes['/public/init'] = {
        body: {
          experiments: [
            {
              id: 'exp-1',
              key: 'checkout',
              name: 'Checkout',
              trafficAllocation: 100,
              variants: [
                { id: 'v1', name: 'local-a', isControl: true, trafficSplit: 50 },
                { id: 'v2', name: 'local-b', isControl: false, trafficSplit: 50 },
              ],
            },
          ],
        },
      };
      service.routes['/public/assign'] = new Error('network down');
      await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1') });
      await settle();

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      expect(platform.storedAssignments()).toEqual([]);

      service.routes['/public/assign'] = unauthorized('token_required');
      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      expect(platform.storedAssignments()).toEqual([]);
    });

    it('returns the cached assignment when the service cannot be reached', async () => {
      await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1') });
      await expect(sdk.getVariant('checkout')).resolves.toBe('blue');

      service.routes['/public/assign'] = new Error('network down');
      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('blue');
      expect(service.to('/public/assign')).toHaveLength(1);
    });

    it('keeps a returning user\'s own assignment when the token cannot be fetched', async () => {
      const token = tokenFor('user-1');
      await sdk.init({ apiKey: 'rv_test_key', tokenProvider: async () => token });
      await expect(sdk.getVariant('checkout')).resolves.toBe('blue');

      // The next visit starts offline: the provider cannot reach the app's server.
      platform.reopen();
      sdk = loadSdk();
      await sdk.init({
        apiKey: 'rv_test_key',
        tokenProvider: async () => {
          throw new Error('offline');
        },
      });

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('blue');
      expect(sdk.isAwaitingUserToken).toBe(true);
    });

    it('several callers asking for one experiment share one request', async () => {
      await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1') });

      const variants = await Promise.all([sdk.getVariant('checkout'), sdk.getVariant('checkout'), sdk.getVariant('checkout')]);

      expect(variants).toEqual(['blue', 'blue', 'blue']);
      expect(service.to('/public/assign')).toHaveLength(1);
    });

    it('honours Retry-After on 429', async () => {
      let now = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      service.routes['/public/assign'] = { status: 429, headers: { 'Retry-After': '120' }, body: {} };
      await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1') });

      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      service.routes['/public/assign'] = assigned('blue');
      now += 119 * 1000;
      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await sdk.trackView('checkout');
      await sdk.flush();
      expect(service.userCalls()).toHaveLength(1);

      now += 2 * 1000;
      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('blue');
    });
  });

  describe('the event queue', () => {
    it('keeps at most 1000 events and drops the oldest', async () => {
      await sdk.init({ apiKey: 'rv_test_key', maxQueueSize: 5000 });
      await sdk.setUserId('user-1');

      for (let i = 0; i < 1005; i++) {
        await sdk.trackCustomEvent('checkout', `event-${i}`);
      }

      const events = platform.stored('events');
      expect(events).toHaveLength(1000);
      expect(events[0].eventName).toBe('event-5');
      expect(events[999].eventName).toBe('event-1004');
      expect(service.userCalls()).toEqual([]);
    });

    it('sends parked events in batches of at most 100, each event once', async () => {
      await sdk.init({ apiKey: 'rv_test_key' });
      await sdk.setUserId('user-1');
      for (let i = 0; i < 250; i++) {
        await sdk.trackCustomEvent('checkout', `event-${i}`);
      }

      await sdk.setUserToken(tokenFor('user-1'));
      await Promise.all([sdk.flush(), sdk.flush(), sdk.flush()]);

      expect(service.to('/public/sync').map((c) => c.body.events.length)).toEqual([100, 100, 50]);
      const ids = service.sentEvents().map((e) => e.id);
      expect(new Set(ids).size).toBe(250);
      expect(platform.stored('events')).toEqual([]);
    });

    it('a refused batch does not take the rest of the queue with it', async () => {
      let request = 0;
      service.routes['/public/sync'] = (call) =>
        ++request === 1 ? { status: 400, body: {} } : { body: { synced: call.body.events.length, failed: 0 } };
      await sdk.init({ apiKey: 'rv_test_key' });
      await sdk.setUserId('user-1');
      for (let i = 0; i < 150; i++) {
        await sdk.trackCustomEvent('checkout', `event-${i}`);
      }

      await sdk.setUserToken(tokenFor('user-1'));
      await sdk.flush();

      expect(service.to('/public/sync').map((c) => c.body.events.length)).toEqual([100, 50]);
      expect(errors).toEqual([{ message: 'Sync refused: HTTP 400' }]);
    });

    it('429 on sync: keeps the events and waits as long as it was told', async () => {
      let now = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      service.routes['/public/sync'] = { status: 429, headers: { 'Retry-After': '90' }, body: {} };
      await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1') });
      await sdk.trackView('checkout');

      await sdk.flush();
      await sdk.flush();
      now += 60 * 1000;
      await sdk.flush();
      expect(service.to('/public/sync')).toHaveLength(1);
      expect(platform.stored('events')).toHaveLength(1);

      service.routes['/public/sync'] = { body: { synced: 1, failed: 0 } };
      now += 31 * 1000;
      await sdk.flush();
      expect(service.to('/public/sync')).toHaveLength(2);
      expect(platform.stored('events')).toEqual([]);
    });

    it('5xx and network failures: keeps the events and backs off', async () => {
      let now = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      service.routes['/public/sync'] = { status: 503, body: {} };
      await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1') });
      await sdk.trackView('checkout');

      await sdk.flush();
      await sdk.flush();
      expect(service.to('/public/sync')).toHaveLength(1);

      now += 31 * 1000;
      await sdk.flush(); // second failure: the next wait is twice as long
      now += 31 * 1000;
      await sdk.flush();
      expect(service.to('/public/sync')).toHaveLength(2);
      expect(platform.stored('events')).toHaveLength(1);
    });

    it('event limit reached: keeps the events, says so once, no storm', async () => {
      service.routes['/public/sync'] = {
        status: 403,
        body: { statusCode: 403, error: 'EVENT_LIMIT_EXCEEDED', code: 'event_limit_reached' },
      };
      await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1') });
      for (let i = 0; i < 120; i++) await sdk.trackView('checkout');
      await settle();

      await sdk.flush();
      await sdk.flush();

      expect(service.to('/public/sync')).toHaveLength(1);
      expect(platform.stored('events')).toHaveLength(120);
      expect(errors).toEqual([{ message: 'Event limit reached', code: 'event_limit_reached' }]);
    });

    it('sends a stable id with every event', async () => {
      let request = 0;
      service.routes['/public/sync'] = () => (++request === 1 ? new Error('network down') : { body: { synced: 1, failed: 0 } });
      let now = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1') });
      await sdk.trackView('checkout');

      await sdk.flush();
      now += 31 * 1000;
      await sdk.flush();

      const [first, second] = service.to('/public/sync');
      expect(first.body.events[0].clientEventId).toBeTruthy();
      expect(second.body.events[0].clientEventId).toBe(first.body.events[0].clientEventId);
    });
  });

  describe('before init', () => {
    it('returns defaults and does nothing instead of throwing', async () => {
      await expect(sdk.getVariant('checkout', 'fallback')).resolves.toBe('fallback');
      await expect(sdk.getVariantConfig('checkout')).resolves.toBeNull();
      await expect(sdk.isFeatureEnabled('dark-mode', true)).resolves.toBe(true);
      await expect(sdk.getFeatureValue('limit', 3)).resolves.toBe(3);
      await expect(sdk.getFeatureFlags()).resolves.toEqual([]);
      await expect(sdk.getExperiments()).resolves.toEqual([]);
      await expect(sdk.getUserId()).resolves.toBeNull();
      await expect(sdk.trackView('checkout')).resolves.toBeUndefined();
      await expect(sdk.setUserId('user-1')).resolves.toBeUndefined();
      await expect(sdk.setUserToken(tokenFor('user-1'))).resolves.toBeUndefined();
      await expect(sdk.refreshUserToken()).resolves.toBeUndefined();
      await expect(sdk.clearUserId()).resolves.toBeUndefined();
      await expect(sdk.flush()).resolves.toBeUndefined();
      expect(sdk.isAwaitingUserToken).toBe(false);
      expect(service.calls).toEqual([]);
    });
  });
});

import { FakeService, tokenFor, settle, platform, loadSdk, stopTimers } from './helpers';
import { setAppState, appStateListeners } from './mocks/react-native';

describe('going to the background', () => {
  let service: FakeService;
  let sdk: ReturnType<typeof loadSdk>;

  beforeEach(() => {
    platform.install();
    service = new FakeService();
    service.install();
    sdk = loadSdk();
  });

  afterEach(async () => {
    await sdk.reset();
    stopTimers();
  });

  it('sends nothing while waiting for a user token', async () => {
    await sdk.init({ apiKey: 'rv_test_key' });
    await sdk.setUserId('user-1');
    await sdk.trackView('checkout');

    setAppState('background');
    await settle();

    expect(service.userCalls()).toEqual([]);
    expect(platform.stored('events')).toHaveLength(1);
  });

  it('sends the queued events of the signed-in user', async () => {
    const token = tokenFor('user-1');
    await sdk.init({ apiKey: 'rv_test_key', userToken: token });
    await sdk.trackView('checkout');

    setAppState('background');
    await settle();

    expect(service.sentEvents()).toEqual([expect.objectContaining({ userId: 'user-1', token })]);
    expect(platform.stored('events')).toEqual([]);
  });

  it('reset() stops listening', async () => {
    await sdk.init({ apiKey: 'rv_test_key' });
    expect(appStateListeners()).toBe(1);

    await sdk.reset();
    expect(appStateListeners()).toBe(0);
  });
});

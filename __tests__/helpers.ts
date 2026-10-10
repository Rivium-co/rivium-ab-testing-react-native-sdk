/** Test helpers: a fake service, user tokens and the device's storage. */

import { clearStorage, storageMap } from './mocks/async-storage';

export interface Call {
  path: string;
  token?: string;
  body: any;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Route = Reply | Error | ((call: Call) => Reply | Error | Promise<Reply | Error>);

const USER_ROUTES = ['/public/assign', '/public/sync', '/public/flag-evaluation', '/public/track', '/public/conversion'];

export class FakeService {
  calls: Call[] = [];
  routes: Record<string, Route> = {
    '/public/init': { body: { experiments: [] } },
    '/public/flags': { body: { flags: [] } },
    '/public/sync': (call) => ({ body: { success: true, synced: call.body.events.length, failed: 0 } }),
  };

  install(): void {
    (globalThis as any).fetch = jest.fn(async (url: string, init: any = {}) => {
      const path = new URL(url).pathname;
      const call: Call = {
        path,
        token: init.headers?.['x-user-token'],
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      this.calls.push(call);

      const route = this.routes[path];
      const reply = typeof route === 'function' ? await route(call) : route;
      if (reply instanceof Error) throw reply;
      if (!reply) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: reply.headers,
      });
    });
  }

  to(path: string): Call[] {
    return this.calls.filter((c) => c.path === path);
  }

  /** Calls that act for a user (and so need a user token). */
  userCalls(): Call[] {
    return this.calls.filter((c) => USER_ROUTES.includes(c.path));
  }

  /** Every event the service was sent, with the token it came under. */
  sentEvents(): { userId: string; token?: string; id: string }[] {
    return this.to('/public/sync').flatMap((c) =>
      c.body.events.map((e: any) => ({ userId: e.userId, token: c.token, id: e.clientEventId }))
    );
  }
}

export function assigned(variantName: string, extra: Record<string, unknown> = {}): Reply {
  return {
    body: {
      data: {
        experimentId: 'exp-1',
        experimentKey: 'checkout',
        variantId: `id-${variantName}`,
        variantKey: variantName,
        variantName,
        config: { color: variantName },
        isControl: false,
        inExperiment: true,
        ...extra,
      },
    },
  };
}

export function unauthorized(code: string): Reply {
  return { status: 401, body: { statusCode: 401, error: 'Unauthorized', code, message: code } };
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let serial = 0;

/** A token shaped like the real one: readable `sub` and `exp`, opaque signature. */
export function tokenFor(userId: string, expiresInS = 3600): string {
  const payload = { sub: userId, exp: Math.floor(Date.now() / 1000) + expiresInS, jti: ++serial };
  return `${base64Url({ alg: 'ES256' })}.${base64Url(payload)}.signature`;
}

export function tokenUser(token?: string): string | undefined {
  if (!token) return undefined;
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub;
}

/** Lets promises that are already on their way settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

const PREFIX = 'rivium_ab_testing_';

/** The platform under the SDK: here a device with AsyncStorage. */
export const platform = {
  /** A fresh install with empty storage. */
  install(): void {
    clearStorage();
  },
  /** The same storage again, as after the app is restarted. */
  reopen(): void {},
  stored(key: string): any {
    const raw = storageMap().get(`${PREFIX}${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  },
  store(key: string, value: unknown): void {
    storageMap().set(`${PREFIX}${key}`, typeof value === 'string' ? value : JSON.stringify(value));
  },
  storedAssignments(): string[] {
    return [...storageMap().keys()].filter((k) => k.startsWith(`${PREFIX}assignment_`));
  },
};

// The SDK's flush timer would keep a finished test run alive.
const realSetInterval = globalThis.setInterval;
const intervals: ReturnType<typeof setInterval>[] = [];
(globalThis as any).setInterval = (...args: Parameters<typeof setInterval>) => {
  const handle = realSetInterval(...args);
  intervals.push(handle);
  return handle;
};

export function stopTimers(): void {
  intervals.splice(0).forEach((handle) => clearInterval(handle));
}

/** A fresh copy of the SDK (it is a module-level object). */
export function loadSdk(): typeof import('../src/index').RiviumAbTesting {
  jest.resetModules();
  return require('../src/index').RiviumAbTesting;
}

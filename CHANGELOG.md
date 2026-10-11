# Changelog

## 0.2.3

- Follows the list cache set in the Rivium console: the experiment list is asked for again once it is older than the console allows.
- A `flushInterval` you pass now wins over the console's send interval; leave it out to follow the console. Changes apply without a restart.
- Sends each event's own time as milliseconds.

## 0.2.2

- Waits for a user token when the app starts before sign-in: `getVariant` and the flag getters return your defaults and events are kept until a token arrives. New `isAwaitingUserToken`, `onAwaitingUserToken()`, `setUserToken()` and `refreshUserToken()`; `tokenProvider` may return `null`.
- Variants are decided by the service only; without an answer the SDK returns the cached assignment or your default.
- `getVariant` and the `track…` methods no longer reject before `init()` or without a user.
- Sign-out and user switch clear the previous user's variants, attributes and pending events.
- The event queue holds at most 1,000 events, sends them in batches and backs off when the service is busy.
- New `clearUserId()` for sign-out.

## 0.2.0

- Signed user tokens: new `tokenProvider` option. Your server mints a Rivium user token and the SDK sends it with every request. Required for assigning variants, tracking and flag evaluation.
- `setUserId` with a different user now clears the previous user's variants and token.
- Fixed server-side assignment and event sync.

# Changelog

## 0.2.0

- Signed user tokens: new `tokenProvider` option. Your server mints a Rivium user token and the SDK sends it with every request. Required for assigning variants, tracking and flag evaluation.
- `setUserId` with a different user now clears the previous user's variants and token.
- Fixed server-side assignment and event sync.

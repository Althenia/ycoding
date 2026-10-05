# Cursor provider ownership

- Maintain the checked-in `.js` implementation and corresponding `.d.ts` declarations together as source; this subtree has no generator or upstream source checkout.
- Preserve Cursor Connect-RPC framing, request/reply fields, authentication, stream settlement, tool continuation, replay, and usage semantics when adapting host integration.
- Keep `LICENSE` and the applicable upstream attribution for MIT-derived code.
- Do not introduce an OpenCode host dependency, discovery root, credential store, or plugin entrypoint into YCoding's active provider path.

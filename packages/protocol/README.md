# Anima protocol

Regenerate the TypeScript and Swift bindings from the repository root:

```sh
pnpm --filter @anima/protocol generate
pnpm --filter @anima/protocol generate:swift
```

The Swift command uses the remote Buf plugins pinned in `buf.gen.swift.yaml`.
It regenerates only `packages/protocol-swift/Sources/AnimaProtocol`, leaving the
Swift package manifest intact.

Add `packages/protocol-swift` as a local Swift package dependency and link the
`AnimaProtocol` library product. Import `AnimaProtocol` to use the protobuf
messages and `Anima_V1_HarnessServiceClient`. Building requires Swift 6.2 or later
on an Apple platform supported by Connect Swift.

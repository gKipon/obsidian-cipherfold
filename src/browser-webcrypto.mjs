// Mobile builds require native WebCrypto; never fall back to Node's crypto.
export const webcrypto=globalThis.crypto;

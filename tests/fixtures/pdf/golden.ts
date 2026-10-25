/**
 * Golden values for the synthetic corpus, shared by the Node golden tests
 * (tests/pdf/golden.test.ts, on Ubuntu and Windows) and the browser ones
 * (tests/e2e/golden-browser.spec.ts): the same file must give the same hashes
 * everywhere, or a verifier on another machine would reject a genuine report.
 * The salts and secret are fixed test values; real ones come from the CSPRNG.
 *
 * Regenerating a fixture changes its docHash. A change to the parser,
 * normaliser or commitments that moves any other value here changes what a
 * stored commitment means, and needs a new normaliser or manifest version.
 */
export const SECRET = new Uint8Array(32).fill(0x42);
export const OPINION_SALT = new Uint8Array(32).fill(0x5a);
export const MANIFEST_SALT = `0x${'a5'.repeat(32)}` as const;

export const GOLDEN: Record<string, { docHash: string; opinionCommitment?: string; manifestHash?: string }> = {
  'en-unmodified.pdf': { docHash: '0x843e3e87caf4c37deb071ea2d479312bbaf264ab97672dc482fd9f4a9ffa5645', opinionCommitment: '0xa90a7fc8d21fab933ed6bb9e7b2a43a8e2d5b38d4bf855f27ccf6ffb23470d51', manifestHash: '0x6d225d7eec0c3ad63b0b5d9b9f04c294dbf122c220f472bd2901dd5218ff779a' },
  'en-qualified.pdf': { docHash: '0x25ad71314009ad869c390372a7839057711c25bf7baacbe3222a1ff0b8266b8d', opinionCommitment: '0xea77ec431505fc6872b2b741d7361898e3e0e2a05e6f71480b71e35fb4d47f95', manifestHash: '0xf4e3e7036a98385a828c38d3563caa1595faed1509c9e285b793a7fbdd892da4' },
  'en-adverse.pdf': { docHash: '0x18e5af428888a2af4f72fda47cf9b8ce604c91ceaa6a15fe5b3e0cb96e5d2ff8', opinionCommitment: '0x98d7a833f2943801483c264a7994a6138fbee6bd763fc26724f33a28d11eea49', manifestHash: '0xe1380372fc7d5045051f32940f308945a60be72ec90b6859907df845051a1332' },
  'en-disclaimer.pdf': { docHash: '0xe8758271921c8493bd9648fd972807bd9dec94abc9ebf2cc17de79d8912f9f1a', opinionCommitment: '0x0e5a515295a87a4b791f5d6b74ca38faec09e86d8cbd053c067fc094c829b4db', manifestHash: '0xbf6c9591a8ee3cfff3b8c81e19d53b738b8f3de72d3a1a4e7e5151e73bb3868a' },
  'bg-unmodified.pdf': { docHash: '0x3fd700b774eb00ddf3574e941e99b41163457d988f7af80dd736c1315df505ff', opinionCommitment: '0xb99a0a4c68663e48d79e384e347a7158b3aea581ef0932e2e953ae731a30c3b9', manifestHash: '0x94e6910870ec7c659d84b3bd1eec319146225b7229addfadcc030afc4364390d' },
  'bg-qualified.pdf': { docHash: '0x312dbb0ad6f5a3c1a08a27b808501d22ddd942a86cb4714787df1cd190d8f403', opinionCommitment: '0x4ad999e307b82564860c9090d04970063314fe086b3ce2ee65c749d6f0be0fe9', manifestHash: '0x116e2662d93f646ca8d8858ae75d5f4d71238330e285576102538e50e95a0e29' },
  'bg-adverse.pdf': { docHash: '0xfa23155efc87bcc8ede57e8cc4cf0d943ab6260f74a19f7f3afbe7c11fcbdcef', opinionCommitment: '0x648de4cc8b6e46b06cfb33c64a6f9f3f73246471f95b7ae440a1dcd7d87b1d7f', manifestHash: '0x9213009ebe3547ea3c15f58b126b6c98ae9dd1f4f0270432ce67f787c24a3f72' },
  'bg-disclaimer.pdf': { docHash: '0x5d1b8b5707f310dcc79024d8374f2932899736cada214dc2e8f4bcfcb3cefa47', opinionCommitment: '0x8cd483b72a961d1b68d1bf6ba31e3488bef704b1c96bd8824883303b770390d2', manifestHash: '0xb8f531ce10fdb6297d1186da71816d665504b4ffb2a6d4f564c484b9538ae609' },
  'en-scanned.pdf': { docHash: '0xfb9df93d6b79fbb2dc1d94e7771e68daa3049d2da83fe2196eeb5ad2fcd913dc' },
  'en-signed.pdf': { docHash: '0xae7a82b16f58a723dc01bab22afadaecf1c10bd0f3aaaea17ab1d3d37d7dbc1a', opinionCommitment: '0xa90a7fc8d21fab933ed6bb9e7b2a43a8e2d5b38d4bf855f27ccf6ffb23470d51', manifestHash: '0xe5768639de917301778ebd186aa212bc33b4d9eee84f9551c7e727197cb28cad' },
};

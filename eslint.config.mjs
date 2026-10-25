import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  {
    // vendor/inflect-ui is upstream code, linted upstream and drift-checked
    // here; editing it to satisfy a local rule is exactly what rule 8 forbids.
    ignores: [
      '.next/**',
      'node_modules/**',
      'vendor/inflect-ui/**',
      'contracts/lib/**',
      'contracts/out/**',
      'contracts/cache/**',
      '.claude/**',
      '.cache/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/vendor/inflect-ui/src/**'],
              message: 'Import vendored components as @inflect/ui/..., the same specifier inflect-compliance uses.',
            },
          ],
        },
      ],
    },
  },
];

export default config;

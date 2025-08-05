import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';

const commonNodeJsFunctionProps = {
  runtime: Runtime.NODEJS_20_X,
  memorySize: 256,
  timeout: Duration.seconds(20),
  handler: 'handler',
  bundling: {
    format: OutputFormat.ESM,
    banner:
      "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
    minify: true,
    esbuildArgs: {
      '--tree-shaking': 'true',
    },
  },
};

export { commonNodeJsFunctionProps };

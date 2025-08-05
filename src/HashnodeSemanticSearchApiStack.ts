import { join } from 'node:path';
import {
  CfnOutput,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  LambdaEdgeEventType,
  OriginRequestPolicy,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { EventBus, Match, Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import {
  FunctionUrlAuthType,
  HttpMethod,
  Version,
} from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import {
  BlockPublicAccess,
  Bucket,
  BucketAccessControl,
  ObjectOwnership,
} from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { commonNodeJsFunctionProps } from './constants';
import { SSMParameterReader } from './SSMParameterReader';

export class HashnodeSemanticSearchApiStack extends Stack {
  public readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Import the function version from the webhook auth stack by using ssm
    const authFunctionVersionReader = new SSMParameterReader(
      this,
      'authAtEdgeFnVersionReader',
      {
        parameterName: 'HashnodeSemanticSearchAuthFunctionVersion',
        region: 'us-east-1',
      }
    );
    const authFunctionVersion = Version.fromVersionArn(
      this,
      'authAtEdgeFnVersion',
      authFunctionVersionReader.getParameterValue()
    );

    // Import the secrets from your account
    const openAiSecret = Secret.fromSecretNameV2(
      this,
      'openAiSecret',
      'openai/api-key'
    );
    const pineconeSecret = Secret.fromSecretNameV2(
      this,
      'pineconeSecret',
      'pinecone/connection-secret-config'
    );

    // Create the DynamoDB table for storing idempotency records
    const table = new Table(this, 'idempotencyTable', {
      partitionKey: {
        name: 'id',
        type: AttributeType.STRING,
      },
      timeToLiveAttribute: 'expiration',
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    // Create the EventBridge event bus for the events sent to the webhook
    const eventBus = new EventBus(this, 'webhookEventBus', {
      eventBusName: 'serverlessWebhookEvents',
    });

    // Create the webhook handler function
    const webhookHandlerFn = new NodejsFunction(this, 'webhookFn', {
      ...commonNodeJsFunctionProps,
      entry: join(__dirname, './functions/api/index.ts'),
      environment: {
        IDEMPOTENCY_TABLE_NAME: table.tableName,
        EVENT_BUS_NAME: eventBus.eventBusName,
      },
    });
    // Create a function URL for the webhook handler function
    const webhookHandlerFnUrl = webhookHandlerFn.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
      cors: {
        allowedMethods: [HttpMethod.GET, HttpMethod.POST],
        allowedOrigins: ['*'],
        allowCredentials: true,
        allowedHeaders: ['*'],
      },
    });
    // Allow the webhook handler function to read/write to the DynamoDB table
    table.grantReadWriteData(webhookHandlerFn);
    // Allow the webhook handler function to publish events to the event bus
    eventBus.grantPutEventsTo(webhookHandlerFn);

    // Create the search handler function
    const searchHandlerFn = new NodejsFunction(this, 'searchFn', {
      ...commonNodeJsFunctionProps,
      entry: join(__dirname, './functions/search/index.ts'),
      environment: {
        OPENAI_API_KEY_NAME: openAiSecret.secretName,
        PINECONE_CONNECTION_SECRET_NAME: pineconeSecret.secretName,
      },
    });
    // Allow the search handler function to read the secrets
    openAiSecret.grantRead(searchHandlerFn);
    pineconeSecret.grantRead(searchHandlerFn);
    // Create a function URL for the webhook handler function
    const searchHandlerFnFnUrl = searchHandlerFn.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
      cors: {
        allowedMethods: [HttpMethod.GET, HttpMethod.POST],
        allowedOrigins: ['*'],
        allowCredentials: true,
        allowedHeaders: ['*'],
      },
    });

    // Create the distribution for the webhook handler
    const commonBehaviorProps = {
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: CachePolicy.CACHING_DISABLED,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy:
        ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT_AND_SECURITY_HEADERS,
      // Add the auth function as a Lambda@Edge function for the origin request
      edgeLambdas: [
        {
          functionVersion: authFunctionVersion,
          eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
          includeBody: true,
        },
      ],
    };
    this.distribution = new Distribution(this, 'webhookDistribution', {
      comment: 'Webhook Distribution',
      defaultBehavior: {
        ...commonBehaviorProps,
        origin: new HttpOrigin(
          Fn.select(2, Fn.split('/', webhookHandlerFnUrl.url))
        ),
        allowedMethods: AllowedMethods.ALLOW_ALL,
      },
      additionalBehaviors: {
        '/search': {
          ...commonBehaviorProps,
          origin: new HttpOrigin(
            Fn.select(2, Fn.split('/', searchHandlerFnFnUrl.url))
          ),
          // cachePolicy: CachePolicy.CACHING_OPTIMIZED,
          // Add the auth function as a Lambda@Edge function for the origin request
          edgeLambdas: [
            {
              ...commonBehaviorProps.edgeLambdas[0],
              includeBody: false,
            },
          ],
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
      },
      errorResponses: [
        { httpStatus: 404, responsePagePath: '/', responseHttpStatus: 200 },
      ],
      enableLogging: true,
      logBucket: new Bucket(this, 'cfAccessLogsBucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        accessControl: BucketAccessControl.PRIVATE,
        objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
        enforceSSL: true,
      }),
    });

    // Set the distribution domain name as an output for easy access
    new CfnOutput(this, 'distribution', {
      value: `https://${this.distribution.distributionDomainName}`,
    });

    // Create the consumer function for the EventBridge events
    const consumerPostCreatedFn = new NodejsFunction(
      this,
      'consumerPostCreatedFn',
      {
        ...commonNodeJsFunctionProps,
        memorySize: 512,
        entry: join(__dirname, './functions/consumer/index.ts'),
        handler: 'handlerPostCreated',
      }
    );
    const postCreatedEventRule = new Rule(this, 'postCreatedEventRule', {
      eventBus,
      eventPattern: {
        source: Match.exactString('serverlessWebhookApi'),
        detailType: Match.exactString('post_created'),
      },
    });
    openAiSecret.grantRead(consumerPostCreatedFn);
    pineconeSecret.grantRead(consumerPostCreatedFn);
    postCreatedEventRule.addTarget(new LambdaFunction(consumerPostCreatedFn));

    const consumerPostUpdatedFn = new NodejsFunction(
      this,
      'consumerPostUpdatedFn',
      {
        ...commonNodeJsFunctionProps,
        entry: join(__dirname, './functions/consumer/index.ts'),
        handler: 'handlerPostUpdated',
      }
    );
    openAiSecret.grantRead(consumerPostUpdatedFn);
    pineconeSecret.grantRead(consumerPostUpdatedFn);
    const postUpdatedEventRule = new Rule(this, 'postUpdatedEventRule', {
      eventBus,
      eventPattern: {
        source: Match.exactString('serverlessWebhookApi'),
        detailType: Match.exactString('post_updated'),
      },
    });
    postUpdatedEventRule.addTarget(new LambdaFunction(consumerPostUpdatedFn));

    const consumerPostDeletedFn = new NodejsFunction(
      this,
      'consumerPostDeletedFn',
      {
        ...commonNodeJsFunctionProps,
        entry: join(__dirname, './functions/consumer/index.ts'),
        handler: 'handlerPostDeleted',
      }
    );
    openAiSecret.grantRead(consumerPostDeletedFn);
    pineconeSecret.grantRead(consumerPostDeletedFn);
    const postDeletedEventRule = new Rule(this, 'postDeletedEventRule', {
      eventBus,
      eventPattern: {
        source: Match.exactString('serverlessWebhookApi'),
        detailType: Match.exactString('post_deleted'),
      },
    });
    postDeletedEventRule.addTarget(new LambdaFunction(consumerPostDeletedFn));
  }
}

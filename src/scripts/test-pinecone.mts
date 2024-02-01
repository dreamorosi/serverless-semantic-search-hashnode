import { getSecret } from "@aws-lambda-powertools/parameters/secrets";
import OpenAI from "openai";
import { Logger } from "@aws-lambda-powertools/logger";
import {
	Pinecone,
	PineconeRecord,
	RecordMetadata,
} from "@pinecone-database/pinecone";
import { type Document } from "langchain/document";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";

type PineconeConnectionSecret = {
	apiKey: string;
	indexName: string;
	environment: string;
};
const logger = new Logger({ logLevel: "INFO", sampleRateValue: 1 });

const event = {
	version: "0",
	id: "6c11a39f-8694-ea10-8500-ef75036cad05",
	"detail-type": "post_created",
	source: "serverlessWebhookApi",
	account: "536254204126",
	time: "2024-02-01T22:44:46Z",
	region: "eu-west-1",
	resources: [],
	detail: {
		uuid: "cd710097-6803-44e0-893c-1c6e0b74fed2",
		post: {
			id: "65a68126b7de1c44080a3881",
			publication: {
				id: "5cf7f8b96576c562343221cc",
			},
			publishedAt: "2024-01-16T13:14:14.744Z",
			updatedAt: null,
			title: "Setting Up Post Schedules with EventBridge Scheduler & CDK",
			subtitle: null,
			brief:
				"One essential feature of any blogging platform is the ability to schedule posts for publication. Hashnode introduced this functionality in June 2022.\nAt that time, the entire feature was based on a CRON job. This CRON job managed all various states a...",
			content: {
				markdown:
					'One essential feature of any blogging platform is the ability to schedule posts for publication. Hashnode [introduced](https://townhall.hashnode.com/introducing-article-scheduling-feature-for-all-hashnode-blogs) this functionality in June 2022.\n\nAt that time, the entire feature was based on a CRON job. This CRON job managed all various states and published the post. The CRON job was running every minute to ensure that scheduled posts were published.\n\nThere were certain cons associated with the CRON job:\n\n* **Unnecessary computation**: The CRON job ran even if no posts were scheduled at that time.\n    \n* **Observability**: Each execution of the CRON job produced logs and traces. It was quite hard to understand if and how many posts were scheduled at a certain time.\n    \n* **Error Handling**: Error handling was quite hard. If one post failed to be published we couldn\'t let the whole processing Lambda fail. Alerting needed special functionalities to handle that.\n    \n\nWith the [launch of EventBridge Scheduler](https://aws.amazon.com/blogs/compute/introducing-amazon-eventbridge-scheduler/) in 2022 we instantly knew that scheduling posts is a perfect use-case for that.\n\n## EventBridge Scheduler\n\n![eventbridge scheduler example](https://cdn.hashnode.com/res/hashnode/image/upload/v1704987466311/ce7b0d1a-b34a-4b14-b42f-8184e7e94136.png align="center")\n\nEventBridge scheduler is a feature of EventBridge that allows users to schedule tasks at precise times. You can schedule a task that will be executed once at an exact time.\n\nThe same targets are supported as for EventBridge, such as:\n\n* Lambda\n    \n* SQS\n    \n* SNS\n    \n* Step Functions\n    \n* ... and many more!\n    \n\n## Scheduling Posts with EventBridge Scheduler\n\n![scheduling posts with eventbridge](https://cdn.hashnode.com/res/hashnode/image/upload/v1705318104814/2df1d43f-f273-469f-916b-71c410841539.png align="center")\n\nLet\'s see how we have implemented the scheduling of posts with the scheduler.\n\n### EventBridge Scheduling Basics\n\nBefore we worked on any API integrations we first created a few resources we needed to share with our API:\n\n1. EventBridge Scheduling Group\n    \n2. Lambda Consumer with DLQ (consumer errors)\n    \n3. SQS Dead-Letter-Queue (server-side errors)\n    \n4. IAM Role\n    \n\n<div data-node-type="callout">\n<div data-node-type="callout-emoji">☝</div>\n<div data-node-type="callout-text">Hashnode uses two different CDK apps. One for all asynchronous workloads in plain <strong>CDK</strong>. And another one with <a target="_blank" rel="noopener noreferrer nofollow" href="https://sst.dev" style="pointer-events: none"><strong>SST</strong></a> for our synchronous APIs. Data needs to be shared via SSM parameters.</div>\n</div>\n\n#### EventBridge Scheduling Group\n\nFor improving the overview of schedules it is recommended to create schedule groups. It is easier to filter your schedules based on these. We have created one group with the name: `SchedulePublishDraft`.\n\n```typescript\nnew CfnScheduleGroup(this, \'SchedulePublishDraft\');\n```\n\nThis group needs to be supplied once the schedule is created.\n\n#### Lambda Consumer\n\n![](https://cdn.hashnode.com/res/hashnode/image/upload/v1704878313368/5b6495a6-219b-4d57-b9a9-738f2631fcc0.png align="center")\n\nNext, we need a Consumer for our EventBridge Schedule. The schedule is scheduled for a specific time. Once this time is reached a target consumer is called.\n\nWe use AWS Lambda for that. The Lambda function will be called **asynchronously**. The asynchronous call gives us the ability to use Lambda Destinations. You have two types of Lambda Destinations:\n\n* `onSuccess`: This is called once the Lambda succeeds\n    \n* `onFailure`: This is called once the Lambda fails\n    \n\nWe make use of the `onFailure` destination. Once the Lambda function encounters some error and fails, we retry the event two times. If it still fails we send it to a Dead-Letter-Queue (DLQ).\n\nThe Lambda function executes the business logic (publishing the post, and updating some database states).\n\n<div data-node-type="callout">\n<div data-node-type="callout-emoji">🚧</div>\n<div data-node-type="callout-text"><strong>Remember:</strong> Your EventBridge consumer needs to be idempotent. If not it can (and will happen) that your consumer is executed twice. Which could result in duplicated post publishes.</div>\n</div>\n\n#### Scheduling DLQ (server-side errors)\n\n![DLQ for EventBridge errors](https://cdn.hashnode.com/res/hashnode/image/upload/v1704878120894/877ce59a-c6b4-44d8-b5ad-d3da86c63e78.png align="center")\n\nThere is a second DLQ we need to supply in our creation of the EventBridge schedule. This DLQ handles all **server-side errors** like missing IAM permissions or Lambda API outages.\n\nWe now have two DLQs in place:\n\n1. The first one is for server-side errors. For example: Missing IAM policies or when the Lambda API is down\n    \n2. The second one is for consumer errors. In case the Lambda function fails, the event will be retried two times and after that sent to a DLQ.\n    \n\nIn this section, we are talking about the **first** **one**. This one is needed to supply while creating the schedule.\n\nWe create this DLQ with CDK as well and share it via a parameter:\n\n```typescript\n\nconst dlqScheduler = new MonitoredDeadLetterQueue(this, \'SchedulerDlq\');\n\nthis.scheduleDeadLetterArn = dlqScheduler.queueArn;\n\nnew StringParameter(this, \'EventBridgeSchedulerDLQArn\', {\n  stringValue: this.scheduleDeadLetterArn,\n  parameterName: `/${envName}/infra/schedulePublishDraft/schedulerDeadLetterQueueArn`\n});\n```\n\nThis gives us the ability to use the parameter in the second API CDK app.\n\n#### IAM Role\n\nWhile creating the schedule you need to supply an IAM Role ARN. This role is used for executing the schedule.\n\nThis is the CDK code we are using:\n\n```typescript\nthis.role = new Role(this, \'RevokeProAccessPublicationRole\', {\n  assumedBy: new ServicePrincipal(\'scheduler.amazonaws.com\')\n});\n\nthis.postPublishLambda.grantInvoke(this.role);\n\n\nnew StringParameter(this, \'TargetRoleArn\', {\n  stringValue: this.role.roleArn,\n  parameterName: `/${envName}/infra/schedulePublishDraft/targetRoleArn`\n});\n```\n\nWe create a role that can be assumed by the scheduler service. We then grant the invoke permissions for one Lambda to this role and save it as a string parameter in SSM.\n\n### C<s>R</s>UD Operations\n\nOne of the main things we needed to think about is how we want to **C**reate, **U**pdate, and **D**elete the schedules. Hashnode uses a [GraphQL API](https://gql.hashnode.com). We have had several mutations for handling schedules already (yes the naming can be quite hard with posts and drafts...):\n\n* `scheduleDraft`\n    \n* `reschedulePost`\n    \n* `cancelScheduledPost`\n    \n\nThese operations handled the creation of documents in our database. Each of these mutation need to handle the EventBridge schedule CRUD operation.\n\n### Schedule Drafts\n\nScheduling a draft needs to create the EventBridge schedule. We have our own package in our monorepo called `@hashnode/scheduling`. This package abstracts the calls to EventBridge and allows us to type it more precisely for our needs.\n\nFor publishing a draft we only need to call the function `schedulePublishDraftScheduler()` and everything else is abstracted. The function will\n\n* Parse incoming data with `zod`\n    \n* Creates the `CreateScheduleCommand`\n    \n* Sends the command to EventBridge to create the schedule\n    \n\nThe create command looks like this:\n\n```typescript\nconst command = new CreateScheduleCommand({\n  Name: createName({\n    draftId\n  }),\n  GroupName: groupName,\n  ScheduleExpression: `at(${formattedDate})`,\n  ScheduleExpressionTimezone: \'UTC\',\n  Target: {\n    Arn: targetArn,\n    RoleArn: targetRoleArn,\n    Input: JSON.stringify(schedulerPayload),\n    DeadLetterConfig: {\n      Arn: deadLetterArn\n    }\n  },\n  FlexibleTimeWindow: { Mode: \'OFF\' },\n  ActionAfterCompletion: \'DELETE\'\n});\n```\n\nThe name of each schedule should be unique (no drafts can be scheduled twice). The name follows this pattern:\n\n```typescript\n`SchedulePublishDraft-${draftId.toString()}`\n```\n\nThe `Target` input object shows you all the data we have created before:\n\n1. `Arn:` ARN of the Lambda function that executes the business logic\n    \n2. `RoleArn:` The ARN of the Role\n    \n3. `DeadLetterConfig.Arn:` The ARN of the DLQ for server-side errors\n    \n\nWe also set the flag `ActionAfterCompletion` to `DELETE` to make sure each schedule is removed after it runs successfully.\n\n### Reschedule Drafts & Cancel Schedules\n\nRescheduling and canceling scheduled drafts follows the same procedure as creating them. In rescheduling, we make sure that the date is valid. We update the schedule.\n\nFor canceling schedules we simply remove the schedule from EventBridge.\n\n## Results after that\n\nWe\'ve deployed everything on production without any issues. A very minimal migration was needed to create schedules for all existing drafts.\n\nNow, if one post publish fails we get alerted immediately with exactly the post that failed.\n\nThe development and integration of using EventBridge Schedules for use cases like this are straightforward. The benefits of simplicity we have are immense.\n\n## Summary\n\nThis post should show you how easy it can be to leverage the managed services of AWS for features like that. The scheduling stack costs 1ct per month at the moment.\n\n![Costs for scheduling stack](https://cdn.hashnode.com/res/hashnode/image/upload/v1704879242633/7505d1dc-fffc-49af-b3dc-b1e376ffe03a.png align="center")\n\nOne alternative approach for tackling this issue of the CRON job would have been to use SQS and partial batch failures. However, the EventBridge scheduling approach is much more simple. **And simple is king.**\n\n## Resources\n\n[Hashnode](https://hashnode.com)\n\n[Join our Discord Server](https://discord.gg/hashnode)',
			},
		},
	},
};

(async () => {
	const pineconeConnectionSecret = await getSecret<PineconeConnectionSecret>(
		"pinecone/connection-secret-config",
		{
			transform: "json",
		},
	);
	// Create an instance of the Pinecone client.
	const pinecone = new Pinecone({
		apiKey: pineconeConnectionSecret?.apiKey || "",
	});
	const pineconeIndex = pinecone.index(
		pineconeConnectionSecret?.indexName || "",
	);

	// Retrieve the OpenAI API key from AWS Secrets Manager.
	const openAiSecret = await getSecret<string>("openai/api-key");
	// Create an instance of the OpenAI client.
	const openAi = new OpenAI({
		apiKey: openAiSecret,
	});
	const openAiEmbeddingModelName = "text-embedding-3-small";

	const embedChunks = async (
		postId: string,
		rawChunks: Document<Record<string, unknown>>[],
	) => {
		const vectors = [];
		const chunkCount = rawChunks.length;
		try {
			for (const [idx, chunk] of rawChunks.entries()) {
				const { data } = await openAi.embeddings.create({
					model: openAiEmbeddingModelName,
					input: chunk.pageContent,
				});

				logger.debug("dd", {
					da: data[0].embedding[0],
				});

				/* logger.debug("embeddings created", {
					chunk,
					postId,
				}); */

				vectors.push({
					id: `${postId}#chunk${idx + 1}`,
					values: data[0].embedding,
					metadata: {
						chunkCount,
					},
				});
			}

			return vectors;
		} catch (error) {
			logger.error("failed to create embeddings", {
				error,
			});

			throw error;
		}
	};

	const putVectorChunks = async (vectors: PineconeRecord<RecordMetadata>[]) => {
		try {
			const res = await pineconeIndex.upsert(vectors);
			console.log(JSON.stringify(res, null, 2));
			/* logger.debug("upsert vectors response", {
				res,
			}); */
		} catch (error) {
			logger.error("failed to upsert vectors", {
				error,
			});

			throw error;
		}
	};

	const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
		chunkSize: 1024,
		chunkOverlap: 128,
	});

	const createChunks = async (
		markdownContent: string,
	): Promise<Document<Record<string, unknown>>[]> => {
		try {
			return await splitter.createDocuments([markdownContent]);
		} catch (error) {
			logger.error("failed to split text into chunks", {
				error,
			});

			throw error;
		}
	};

	const {
		post: { id: postId, content },
	} = event.detail;

	// Create chunks from the post content, each chunk is a part of the post
	const rawChunks = await createChunks(content.markdown);
	// Embed each chunk into a vector
	const vectors = await embedChunks(postId, [rawChunks[0], rawChunks[1]]);
	// Put the vectors into Pinecone
	await putVectorChunks(vectors);
})();

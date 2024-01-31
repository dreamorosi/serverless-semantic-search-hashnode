import { getSecret } from "@aws-lambda-powertools/parameters/secrets";
import OpenAI from "openai";
import {
	Pinecone,
	type RecordMetadata,
	type ScoredPineconeRecord,
} from "@pinecone-database/pinecone";
import { Logger } from "@aws-lambda-powertools/logger";
import type { LambdaFunctionURLEventWithIAMAuthorizer } from "aws-lambda";
import type { PineconeConnectionSecret } from "./types.js";
import { Client, OperationResult, fetchExchange, gql } from "@urql/core";

const logger = new Logger({ logLevel: "DEBUG" });

// Retrieve the OpenAI API key from AWS Secrets Manager.
const openAiSecret = await getSecret<string>("openai/api-key");
// Create an instance of the OpenAI client.
const openAi = new OpenAI({
	apiKey: openAiSecret,
});
const openAiEmbeddingModelName = "text-embedding-3-small";

// Retrieve the Pinecone connection secret from AWS Secrets Manager.
const pineconeConnectionSecret = await getSecret<PineconeConnectionSecret>(
	"pinecone/connection-secret-config",
	{
		transform: "json",
	},
);
// Create an instance of the Pinecone client.
const pinecone = new Pinecone({
	apiKey: pineconeConnectionSecret?.apiKey || "",
	environment: pineconeConnectionSecret?.environment || "",
});
const pineconeIndex = pinecone.index(pineconeConnectionSecret?.indexName || "");

// Create GraphQL client
const gqlClient = new Client({
	url: "https://gql.hashnode.com",
	exchanges: [fetchExchange],
});

export const handler = async (
	event: LambdaFunctionURLEventWithIAMAuthorizer,
) => {
	logger.debug("event", {
		event,
	});

	const { queryStringParameters } = event;
	if (
		queryStringParameters === undefined ||
		!Object.hasOwn(queryStringParameters, "text") ||
		queryStringParameters.text === undefined
	) {
		logger.error("missing query string parameter 'text'", {
			queryStringParameters,
		});

		return {
			statusCode: 400,
			body: JSON.stringify({
				message: "Bad request, missing query string parameter 'text'",
			}),
		};
	}
	const text = queryStringParameters.text;

	let vector: number[] = [];
	try {
		const { data } = await openAi.embeddings.create({
			model: openAiEmbeddingModelName,
			input: text,
		});

		vector = data[0].embedding;
	} catch (error) {
		logger.error("unable to create embeddings", { error });

		return {
			statusCode: 500,
			body: JSON.stringify({
				message: "Error creating embeddings",
				error,
			}),
		};
	}

	let foundVectors: ScoredPineconeRecord<RecordMetadata>[] = [];
	try {
		const res = await pineconeIndex.query({
			vector,
			topK: 3,
			includeValues: false,
		});

		foundVectors = res.matches;
	} catch (error) {
		logger.error("unable to query index", { error });

		return {
			statusCode: 500,
			body: JSON.stringify({
				message: "Error querying index",
				error,
			}),
		};
	}

	logger.debug("foundVectors", { foundVectors });

	let foundPosts = [];
	try {
		const results = await Promise.allSettled(
			foundVectors.map(({ id }) =>
				gqlClient
					.query(
						gql`query Post($id: ID!) {
              post(id: $id) {
                id
                author {
                  username
                  name
                }
                title
                brief
              }
            }`,
						{ id: id.replace(/#chunk\d+/, "") },
					)
					.toPromise(),
			),
		);

		logger.debug("results", { results });

		if (
			results.every(
				(query) =>
					query.status === "rejected" ||
					(query as PromiseFulfilledResult<OperationResult>).value.error,
			)
		) {
			logger.error("unable to fetch posts", { results });

			return {
				statusCode: 500,
				body: JSON.stringify({
					message: "Error fetching posts from Hashnode",
				}),
			};
		}

		foundPosts = results.map((query, idx) => ({
			post: (query as PromiseFulfilledResult<OperationResult>).value.data.post,
			similarity_score: foundVectors[idx].score,
		}));
	} catch (error) {
		logger.error("unable to fetch posts", { error });

		return {
			statusCode: 500,
			body: JSON.stringify({
				message: "Error fetching posts",
				error,
			}),
		};
	}

	return {
		statusCode: 200,
		body: JSON.stringify({
			matches: foundPosts,
		}),
	};
};

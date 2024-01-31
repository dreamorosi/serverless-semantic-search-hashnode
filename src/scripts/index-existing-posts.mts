import { SecretsProvider } from "@aws-lambda-powertools/parameters/secrets";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createHmac, randomUUID } from "node:crypto";
import { Client, fetchExchange, gql } from "@urql/core";

const BLOG_HOST = "engineering.hashnode.com";
const WEBHOOK_URL = "https://your-webhook-url.com/webhook";

const secretsProvider = new SecretsProvider({
	awsSdkV3Client: new SecretsManagerClient({
		region: "us-east-1",
	}),
});

type CreateSignatureOptions = {
	/**
	 * The timestamp of the signature.
	 */
	timestamp: number;
	/**
	 * The payload to be signed.
	 */
	payload?: Record<string, unknown>;
	/**
	 * The secret of your webhook (`whsec_...`).
	 */
	secret: string;
};

const createSignature = (options: CreateSignatureOptions): string => {
	const { timestamp, payload, secret } = options;
	const signedPayloadString = `${timestamp}.${
		payload ? JSON.stringify(payload) : ""
	}`;
	return createHmac("sha256", secret).update(signedPayloadString).digest("hex");
};

const query = gql`query Publication($host: String!, $after: String) {
	publication(host: $host) {
			posts(first: 20, after: $after) {
					edges {
							node {
									id
									title
									publication {
										id
									}
							}
					}
					pageInfo {
							hasNextPage
							endCursor
					}
			}
	}
}`;

// Create GraphQL client
const gqlClient = new Client({
	url: "https://gql.hashnode.com",
	exchanges: [fetchExchange],
});

const getAllPostsFromApi = async () => {
	let hasNextPage = true;
	let after = null;
	const posts = [];
	while (hasNextPage) {
		const result = await gqlClient
			.query(query, {
				host: BLOG_HOST,
				after,
			})
			.toPromise();

		if (result.error) {
			console.error(result.error);
			return;
		}

		const {
			publication: {
				posts: {
					edges,
					pageInfo: { hasNextPage: _hasNextPage, endCursor },
				},
			},
		} = result.data as {
			publication: {
				posts: {
					edges: {
						node: {
							id: string;
							title: string;
							publication: {
								id: string;
							};
						};
					}[];
					pageInfo: {
						hasNextPage: boolean;
						endCursor: string;
					};
				};
			};
		};

		hasNextPage = _hasNextPage;
		after = endCursor;

		posts.push(...edges);
	}

	return posts;
};

(async () => {
	const posts = (await getAllPostsFromApi()) || [];

	const hashnodeSecret = await secretsProvider.get<string>(
		"hashnode/webhook-secret",
	);

	for (const post of posts) {
		const timestamp = Date.now();
		const payload = {
			metadata: {
				uuid: randomUUID(),
			},
			data: {
				publication: {
					id: post.node.publication.id,
				},
				post: {
					id: post.node.id,
				},
				eventType: "post_created",
			},
		};

		const signature = createSignature({
			timestamp,
			payload,
			secret: hashnodeSecret || "",
		});

		await fetch(WEBHOOK_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-hashnode-signature": `t=${timestamp},v1=${signature}`,
			},
			body: JSON.stringify(payload),
		});
	}
})();

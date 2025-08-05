import { Logger } from '@aws-lambda-powertools/logger';
import { getSecret } from '@aws-lambda-powertools/parameters/secrets';
import {
  Pinecone,
  type PineconeRecord,
  type RecordMetadata,
} from '@pinecone-database/pinecone';
import type { Document } from 'langchain/document';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import OpenAI from 'openai';
import type { PineconeConnectionSecret } from './types.js';

const logger = new Logger({ logLevel: 'INFO', sampleRateValue: 1 });

// Retrieve the Pinecone connection secret from AWS Secrets Manager.
const pineconeConnectionSecret = await getSecret<PineconeConnectionSecret>(
  'pinecone/connection-secret-config',
  {
    transform: 'json',
  }
);
// Create an instance of the Pinecone client.
const pinecone = new Pinecone({
  apiKey: pineconeConnectionSecret?.apiKey || '',
});
const pineconeIndex = pinecone.index(pineconeConnectionSecret?.indexName || '');

const getVectorChunkCount = async (postId: string): Promise<number> => {
  try {
    const firstChunk = await pineconeIndex.fetch([`${postId}#chunk1`]);

    logger.debug('fetch vector chunks count response', {
      firstChunk,
    });

    return firstChunk.records[0].metadata?.chunkCount as number;
  } catch (error) {
    logger.error('failed to fetch vector chunks count', {
      error,
    });

    throw error;
  }
};

const deleteVectorChunks = async (postId: string, chunkCount: number) => {
  try {
    const res = await pineconeIndex.deleteMany(
      Array.from(
        { length: chunkCount },
        (_, idx) => `${postId}#chunk${idx + 1}`
      )
    );
    logger.debug('delete vectors response', {
      res,
    });
  } catch (error) {
    logger.error('failed to delete vectors', {
      error,
    });

    throw error;
  }
};

const putVectorChunks = async (vectors: PineconeRecord<RecordMetadata>[]) => {
  try {
    const res = await pineconeIndex.upsert(vectors);
    logger.debug('upsert vectors response', {
      res,
      pineconeSecret: pineconeConnectionSecret,
    });
  } catch (error) {
    logger.error('failed to upsert vectors', {
      error,
    });

    throw error;
  }
};

// Retrieve the OpenAI API key from AWS Secrets Manager.
const openAiSecret = await getSecret<string>('openai/api-key');
// Create an instance of the OpenAI client.
const openAi = new OpenAI({
  apiKey: openAiSecret,
});
const openAiEmbeddingModelName = 'text-embedding-3-small';

const embedChunks = async (
  postId: string,
  rawChunks: Document<Record<string, unknown>>[]
) => {
  const vectors = [];
  const chunkCount = rawChunks.length;
  try {
    for (const [idx, chunk] of rawChunks.entries()) {
      const { data } = await openAi.embeddings.create({
        model: openAiEmbeddingModelName,
        input: chunk.pageContent,
      });

      logger.debug('embeddings created', {
        chunk,
        postId,
      });

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
    logger.error('failed to create embeddings', {
      error,
    });

    throw error;
  }
};

const splitter = RecursiveCharacterTextSplitter.fromLanguage('markdown', {
  chunkSize: 500,
  chunkOverlap: 50,
});

const createChunks = async (
  markdownContent: string
): Promise<Document<Record<string, unknown>>[]> => {
  try {
    return await splitter.createDocuments([markdownContent]);
  } catch (error) {
    logger.error('failed to split text into chunks', {
      error,
    });

    throw error;
  }
};

export {
  logger,
  pineconeIndex,
  getVectorChunkCount,
  deleteVectorChunks,
  putVectorChunks,
  createChunks,
  embedChunks,
};

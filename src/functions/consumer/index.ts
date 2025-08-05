import type { EventBridgeEvent } from 'aws-lambda';
import type {
  EventType,
  PostCreated,
  PostDeleted,
  PostUpdated,
} from './types.js';
import {
  createChunks,
  deleteVectorChunks,
  embedChunks,
  getVectorChunkCount,
  logger,
  putVectorChunks,
} from './utils.js';

export const handlerPostCreated = async (
  event: EventBridgeEvent<EventType, PostCreated>
) => {
  logger.debug('Received event', { event });

  const {
    post: { id: postId, content },
  } = event.detail;

  // Create chunks from the post content, each chunk is a part of the post
  const rawChunks = await createChunks(content.markdown);
  // Embed each chunk into a vector
  const vectors = await embedChunks(postId, rawChunks);
  // Put the vectors into Pinecone
  await putVectorChunks(vectors);
};

export const handlerPostUpdated = async (
  event: EventBridgeEvent<EventType, PostUpdated>
) => {
  logger.debug('Received event', { event });

  const {
    post: { id: postId, content },
  } = event.detail;

  // Get the number of chunks for the post being updated
  const chunkCount = await getVectorChunkCount(postId);
  // Delete the existing chunks for the post being updated
  await deleteVectorChunks(postId, chunkCount);

  // Create chunks from the post content, each chunk is a part of the updated post
  const rawChunks = await createChunks(content.markdown);
  // Embed each chunk into a vector
  const vectors = await embedChunks(postId, rawChunks);
  // Put the vectors into Pinecone
  await putVectorChunks(vectors);
};

export const handlerPostDeleted = async (
  event: EventBridgeEvent<EventType, PostDeleted>
) => {
  logger.debug('Received event', { event });

  const {
    post: { id: postId },
  } = event.detail;

  // Get the number of chunks for the post being deleted
  const chunkCount = await getVectorChunkCount(postId);
  // Delete the existing chunks for the post being deleted
  await deleteVectorChunks(postId, chunkCount);
};

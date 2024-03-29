import {
	createHash,
	createHmac,
	type BinaryLike,
	type Hmac,
	type KeyObject,
	timingSafeEqual,
} from "node:crypto";
import type {
	CreateSignatureOptions,
	ValidateSignatureOptions,
	ValidateSignatureResult,
} from "./types.js";

class Sha256 {
	private readonly hash: Hmac;

	public constructor(secret?: unknown) {
		this.hash = secret
			? createHmac("sha256", secret as BinaryLike | KeyObject)
			: createHash("sha256");
	}

	public digest(): Promise<Uint8Array> {
		const buffer = this.hash.digest();

		return Promise.resolve(new Uint8Array(buffer.buffer));
	}

	public update(array: Uint8Array): void {
		this.hash.update(array);
	}
}

const MILLISECONDS_PER_SECOND = 1_000;
const SIGNATURE_VERSION = "1";

/**
 * Parses the signature header and returns the timestamp and signature.
 *
 * @example
 * parseSignatureHeader('t=1629780000,v1=0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b')
 */
const parseSignatureHeader = (
	header: string,
): {
	success: boolean;
	data: { timestamp: number; signature: string } | null;
} => {
	const parts = header.split(",");
	const timestamp = parts.find((part) => part.startsWith("t="))?.split("=")[1];
	const signature = parts
		.find((part) => part.startsWith(`v${SIGNATURE_VERSION}=`))
		?.split("=")[1];

	if (!timestamp || !signature) {
		return { success: false as const, data: null };
	}

	return {
		success: true as const,
		data: { timestamp: parseInt(timestamp, 10), signature },
	};
};

const createSignature = (options: CreateSignatureOptions): string => {
	const { timestamp, payload, secret } = options;
	const signedPayloadString = `${timestamp}.${
		payload ? JSON.stringify(payload) : ""
	}`;
	return createHmac("sha256", secret).update(signedPayloadString).digest("hex");
};

/**
 * Checks the signature validity and whether the timestamp is within the validForSeconds window.
 */
const validateSignature = (
	options: ValidateSignatureOptions,
): ValidateSignatureResult => {
	const {
		incomingSignatureHeader,
		payload,
		secret,
		validForSeconds = 30,
	} = options;

	if (!incomingSignatureHeader) {
		return { isValid: false, reason: "Missing signature" };
	}

	const { success: isParsingSuccessful, data: parseSignatureHeaderData } =
		parseSignatureHeader(incomingSignatureHeader);
	if (!isParsingSuccessful || !parseSignatureHeaderData) {
		return { isValid: false, reason: "Invalid signature header" };
	}

	const {
		timestamp: incomingSignatureTimestamp,
		signature: incomingSignature,
	} = parseSignatureHeaderData;

	const signature = createSignature({
		timestamp: incomingSignatureTimestamp,
		payload,
		secret,
	});
	const isSignatureValid = compareSignatures(signature, incomingSignature);
	if (!isSignatureValid) {
		return { isValid: false, reason: "Invalid signature" };
	}

	if (validForSeconds !== 0) {
		const differenceInSeconds = Math.abs(
			(Date.now() - incomingSignatureTimestamp) / MILLISECONDS_PER_SECOND,
		);

		const isTimestampValid = differenceInSeconds <= validForSeconds;
		if (!isTimestampValid) {
			return { isValid: false, reason: "Invalid timestamp" };
		}
	}

	return { isValid: true };
};

const compareSignatures = (signatureA: string, signatureB: string): boolean => {
	try {
		return timingSafeEqual(Buffer.from(signatureA), Buffer.from(signatureB));
	} catch (error) {
		return false;
	}
};

export { Sha256, validateSignature };

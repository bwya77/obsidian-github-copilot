import { requestUrl, RequestUrlResponse } from "obsidian";
import Logger from "../../helpers/Logger";
import { ReasoningEffort } from "../models";

export interface SendMessageRequest {
	intent: boolean;
	model: string;
	reasoning_effort?: ReasoningEffort;
	temperature?: number;
	top_p: number;
	n: number;
	stream: boolean;
	messages: {
		content: string;
		role: "user" | "assistant" | "system";
	}[];
}

export interface SendMessageResponse {
	choices: {
		content_filter_results: {
			hate: {
				filtered: boolean;
				severity: string;
			};
			self_harm: {
				filtered: boolean;
				severity: string;
			};
			sexual: {
				filtered: boolean;
				severity: string;
			};
			violence: {
				filtered: boolean;
				severity: string;
			};
		};
		finish_reason: string;
		index: number;
		message: {
			content: string;
			role: string;
		};
	}[];
	created: number;
	id: string;
	model: string;
	prompt_filter_results: {
		content_filter_results: {
			hate: {
				filtered: boolean;
				severity: string;
			};
			self_harm: {
				filtered: boolean;
				severity: string;
			};
			sexual: {
				filtered: boolean;
				severity: string;
			};
			violence: {
				filtered: boolean;
				severity: string;
			};
		};
		prompt_index: number;
	}[];
	system_fingerprint: string;
	usage: {
		completion_tokens: number;
		completion_tokens_details: {
			accepted_prediction_tokens: number;
			audio_tokens: number;
			reasoning_tokens: number;
			rejected_prediction_tokens: number;
		};
		prompt_tokens: number;
		prompt_tokens_details: {
			audio_tokens: number;
			cached_tokens: number;
		};
		total_tokens: number;
	};
}

/**
 * Send a message to the GitHub Copilot API
 * @param data The message data to send
 * @param accessToken The access token for authentication
 * @returns Promise with the response data
 */
export const sendMessage = async (
	data: SendMessageRequest,
	accessToken: string,
	apiBaseUrl: string,
): Promise<SendMessageResponse> => {
	try {
		const response: RequestUrlResponse = await requestUrl({
			url: `${apiBaseUrl}/chat/completions`,
			method: "POST",
			// `throw: false` so we get the actual response (status + body)
			// back on non-2xx instead of an opaque generic Error from
			// Obsidian's requestUrl, which otherwise masks the real cause.
			throw: false,
			headers: {
				Accept: "*/*",
				"Content-Type": "application/json",
				"editor-version": "vscode/1.80.1",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify(data),
		});

		if (response.status !== 200) {
			const bodyText =
				typeof response.text === "string"
					? response.text
					: JSON.stringify(response.json);
			Logger.getInstance().error(
				`Send message failed with status ${response.status}: ${bodyText}`,
			);
			throw new Error(
				`Failed to send message: HTTP ${response.status} - ${bodyText}`,
			);
		}

		return await response.json;
	} catch (error) {
		Logger.getInstance().error(`Error sending message: ${error}`);
		throw error instanceof Error
			? error
			: new Error("Failed to send message");
	}
};

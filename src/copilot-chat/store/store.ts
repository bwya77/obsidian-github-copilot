import { create } from "zustand";
import { StateCreator } from "zustand";
import { AuthSlice, createAuthSlice } from "./slices/auth";
import { MessageSlice, createMessageSlice } from "./slices/message";
import {
	ConversationSlice,
	createConversationSlice,
} from "./slices/conversation";
import {
	ActiveFileSlice,
	createActiveFileSlice,
} from "./slices/activeFile";

type StoreState = AuthSlice & MessageSlice & ConversationSlice & ActiveFileSlice;

type BoundStateCreator<T> = StateCreator<StoreState, [], [], T>;

const boundAuthSlice: BoundStateCreator<AuthSlice> = (...a) => ({
	...createAuthSlice(...a),
});

const boundMessageSlice: BoundStateCreator<MessageSlice> = (...a) => ({
	...createMessageSlice(...a),
});

const boundConversationSlice: BoundStateCreator<ConversationSlice> = (
	...a
) => ({
	...createConversationSlice(...a),
});

const boundActiveFileSlice: BoundStateCreator<ActiveFileSlice> = (...a) => ({
	...createActiveFileSlice(...a),
});

export const useCopilotStore = create<StoreState>()((...a) => ({
	...boundAuthSlice(...a),
	...boundMessageSlice(...a),
	...boundConversationSlice(...a),
	...boundActiveFileSlice(...a),
}));

export const useAuthStore = useCopilotStore;

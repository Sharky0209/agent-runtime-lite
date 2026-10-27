import {createHash} from 'node:crypto';
import {StateStore} from './state.mjs';

// This is a host-driven bridge, NOT an autonomous ChatGPT/website client.
// A provider must independently confirm that the exact turn stopped before
// the outbox may dispatch even one continuation.
const terminal = new Set(['failed', 'timed_out', 'interrupted']);
const statuses = new Set(['active', 'completed', 'cancelled', ...terminal]);
const fail = name => { throw Error(name); };
const snapshot = obj => JSON.parse(JSON.stringify(obj));
const validId = s => typeof s === 'string' && s.trim().length > 0 && s.length <= 512;
const identity = ({taskId,conversationId,turnId}) => JSON.stringify([taskId,conversationId,turnId]);
const operationKey = id => 'arl-chat-' + createHash('sha256').update(id).digest('hex').slice(0,32);

export class ChatContinuationGuard {
  constructor(root, {now = () => Date.now()} = {}) {
    this.store = new StateStore(root);
    this.now = now;
  }

  watch({taskId, conversationId, turnId, continuationMessage,
    stallMs = 120000, maxContinuationsPerTask = 2}) {
    if (![taskId, conversationId, turnId].every(validId) ||
      typeof continuationMessage !== 'string' || !continuationMessage.trim() ||
      continuationMessage.length > 8000) fail('CHAT_WATCH_INVALID');
    if (!Number.isSafeInteger(stallMs) || stallMs < 30000 || stallMs > 86400000 ||
      !Number.isSafeInteger(maxContinuationsPerTask) || maxContinuationsPerTask < 1 ||
      maxContinuationsPerTask > 5) fail('CHAT_POLICY_INVALID');
    const key = identity({taskId,conversationId,turnId});
    return this.store.update(state => {
      if (!state.tasks[taskId]) fail('TASK_NOT_FOUND');
      state.chatWatches ||= {};
      const found = state.chatWatches[key];
      if (found) {
        if (found.continuationMessage !== continuationMessage ||
          found.stallMs !== stallMs || found.maxContinuationsPerTask !== maxContinuationsPerTask) {
          fail('CHAT_WATCH_PAYLOAD_CONFLICT');
        }
        return {deduplicated:true, watch:snapshot(found)};
      }
      const now = new Date(this.now()).toISOString();
      const row = {taskId,conversationId,turnId,continuationMessage,
        stallMs,maxContinuationsPerTask,status:'active',sequence:-1,
        progressKey:null,lastProgressAt:now,createdAt:now,updatedAt:now,
        dispatch:null};
      state.chatWatches[key] = row;
      return {deduplicated:false,watch:snapshot(row)};
    });
  }

  observe({taskId,conversationId,turnId,sequence,status,progressKey = null}) {
    if (!statuses.has(status) || !Number.isSafeInteger(sequence) || sequence < 0 ||
      (progressKey !== null && !validId(progressKey))) fail('CHAT_OBSERVATION_INVALID');
    const key = identity({taskId,conversationId,turnId});
    return this.store.update(state => {
      const watch = state.chatWatches?.[key];
      if (!watch) fail('CHAT_WATCH_NOT_FOUND');
      if (sequence <= watch.sequence) return {deduplicated:true,watch:snapshot(watch)};
      // Once a final answer is observed, older/late errors must not reactivate it.
      if (watch.status === 'completed' || watch.status === 'cancelled') {
        return {deduplicated:true,watch:snapshot(watch)};
      }
      watch.sequence = sequence;
      watch.status = status;
      if (status === 'active' && progressKey !== null && progressKey !== watch.progressKey) {
        watch.progressKey = progressKey;
        watch.lastProgressAt = new Date(this.now()).toISOString();
      }
      watch.updatedAt = new Date(this.now()).toISOString();
      return {deduplicated:false,watch:snapshot(watch)};
    });
  }

  status({taskId,conversationId,turnId}) {
    const row = this.store.read().chatWatches?.[identity({taskId,conversationId,turnId})];
    if (!row) fail('CHAT_WATCH_NOT_FOUND');
    return snapshot(row);
  }

  plan(keys) {
    const watch = this.status(keys);
    const ageMs = Math.max(0,this.now() - Date.parse(watch.lastProgressAt));
    const reason = watch.dispatch ? watch.dispatch.state :
      watch.status === 'completed' || watch.status === 'cancelled' ? watch.status :
      terminal.has(watch.status) ? 'reported_failure' :
      ageMs >= watch.stallMs ? 'suspected_stall' : 'active';
    return {taskId:watch.taskId,conversationId:watch.conversationId,turnId:watch.turnId,
      reason,ageMs,needsProviderReadback:reason === 'reported_failure' || reason === 'suspected_stall',
      // Suspected silence alone never authorizes a second ChatGPT message.
      canSendWithoutReadback:false,dispatch:watch.dispatch && snapshot(watch.dispatch)};
  }

  async tick(keys, adapter) {
    if (!adapter || typeof adapter.readTurn !== 'function' ||
      typeof adapter.sendContinuation !== 'function') fail('CHAT_ADAPTER_INVALID');
    // Head must be checked atomically at the provider's actual send boundary.
    // A read-then-click implementation cannot uphold this contract.
    if (adapter.capabilities?.atomicHeadCheck !== true ||
      adapter.capabilities?.durableIdempotency !== true) {
      return {action:'none',reason:'PROVIDER_ATOMIC_SEND_UNAVAILABLE'};
    }
    const plan = this.plan(keys);
    if (!plan.needsProviderReadback) return {action:'none',reason:plan.reason};
    const before = await adapter.readTurn({conversationId:keys.conversationId,turnId:keys.turnId});
    if (!before || before.conversationId !== keys.conversationId ||
      before.turnId !== keys.turnId) return {action:'none',reason:'IDENTITY_UNVERIFIED'};
    if (before.status === 'completed' || before.hasNewerMessages === true) {
      // Readback vetoes a stale local timeout; never post into a moved chat.
      return {action:'none',reason:'ALREADY_ADVANCED'};
    }
    if (!terminal.has(before.status) || before.headMatches !== true ||
      before.hasNewerMessages !== false || !validId(before.headId)) {
      return {action:'none',reason:'PROVIDER_NOT_TERMINAL'};
    }
    const key = identity(keys);
    const claim = this.store.update(state => {
      const watch = state.chatWatches?.[key];
      if (!watch) fail('CHAT_WATCH_NOT_FOUND');
      if (watch.dispatch || ['completed','cancelled'].includes(watch.status)) {
        return {claimed:false,reason:'ALREADY_CLAIMED_OR_CLOSED'};
      }
      const ageMs = this.now() - Date.parse(watch.lastProgressAt);
      if (!terminal.has(watch.status) && ageMs < watch.stallMs) {
        return {claimed:false,reason:'RECENT_PROGRESS'};
      }
      const total = Object.values(state.chatWatches).filter(other =>
        other.taskId === watch.taskId && other.dispatch).length;
      if (total >= watch.maxContinuationsPerTask) return {claimed:false,reason:'TASK_CONTINUATION_LIMIT'};
      const at = new Date(this.now()).toISOString();
      const dispatch = {state:'reserved_uncertain',operationKey:operationKey(key),
        headId:before.headId,reason:before.status,reservedAt:at,receipt:null};
      // Claim BEFORE side effects: a crash cannot turn into a blind resend.
      watch.dispatch = dispatch;
      watch.updatedAt = at;
      return {claimed:true,dispatch:snapshot(dispatch),message:watch.continuationMessage};
    });
    if (!claim.claimed) return {action:'none',reason:claim.reason};
    try {
      const receipt = await adapter.sendContinuation({
        conversationId:keys.conversationId,turnId:keys.turnId,
        expectedHeadId:claim.dispatch.headId,operationKey:claim.dispatch.operationKey,
        message:claim.message
      });
      // Sending/acceptance is not proof of visible delivery.
      const updated = this.store.update(state => {
        const dispatch = state.chatWatches[key].dispatch;
        dispatch.state = 'submitted_unverified';
        dispatch.receipt = receipt && typeof receipt.messageId === 'string'
          ? {messageId:receipt.messageId} : null;
        return snapshot(dispatch);
      });
      return {action:'submitted_unverified',dispatch:updated};
    } catch {
      // Timeout, thrown error or process exit might still mean the message was sent.
      return {action:'uncertain',reason:'SEND_OUTCOME_UNKNOWN',
        operationKey:claim.dispatch.operationKey};
    }
  }

  async reconcile(keys, adapter) {
    if (!adapter || typeof adapter.readDelivery !== 'function') fail('CHAT_READBACK_REQUIRED');
    const watch = this.status(keys);
    if (!watch.dispatch) return {status:'NO_DISPATCH'};
    if (watch.dispatch.state === 'confirmed') return {status:'confirmed',dispatch:watch.dispatch};
    const result = await adapter.readDelivery({
      conversationId:watch.conversationId,turnId:watch.turnId,
      operationKey:watch.dispatch.operationKey,receipt:watch.dispatch.receipt
    });
    if (!result || result.conversationId !== watch.conversationId ||
      result.operationKey !== watch.dispatch.operationKey ||
      result.status !== 'confirmed' || !validId(result.messageId) ||
      (watch.dispatch.receipt?.messageId && watch.dispatch.receipt.messageId !== result.messageId)) {
      return {status:'UNCERTAIN_NO_RESEND'};
    }
    return this.store.update(state => {
      const row = state.chatWatches[identity(keys)];
      row.dispatch.state = 'confirmed';
      row.dispatch.confirmedAt = new Date(this.now()).toISOString();
      row.dispatch.receipt = {messageId:result.messageId};
      return {status:'confirmed',dispatch:snapshot(row.dispatch)};
    });
  }
}

import { safeFailureMessage } from "../../api/failure-message";

type NodeErrorPresentation = {
  code: string;
  zh: string;
  en: string;
};

/**
 * Converts unstable provider/browser messages into a small, stable set of
 * user-facing errors. The code identifies the error category for support; it
 * deliberately does not expose raw upstream payloads or prescribe an action.
 */
export function getNodeErrorPresentation(error: string): NodeErrorPresentation {
  const e = error.toLowerCase();
  const result = (code: string, zh: string, en: string): NodeErrorPresentation => ({ code, zh, en });
  const providerStatusMatch = error.match(/(?:Provider|上游) HTTP (\d{3})/i);
  const providerStatus = providerStatusMatch ? Number(providerStatusMatch[1]) : 0;

  const looksLikeLocalStorageQuota =
    e.includes('quotaexceeded')
    || e.includes('localstorage')
    || e.includes('local storage')
    || (e.includes('failed to execute') && e.includes('setitem'))
    || (e.includes('dom exception') && e.includes('quota'));
  if (looksLikeLocalStorageQuota) {
    return result('E1001', '本地存储空间不足，本次结果未能保存。', 'Local storage is full; this result could not be saved.');
  }
  if (e.includes('额度不足') || e.includes('余额不足') || e.includes('积分不足') || e.includes('quota') || e.includes('insufficient_credits') || providerStatus === 402) {
    return result('E1002', '服务额度不足，本次生成未完成。', 'Service credit is insufficient; generation was not completed.');
  }
  if (e.includes('invalid token') || e.includes('unauthorized') || providerStatus === 401 || providerStatus === 403) {
    return result('E1003', '模型服务授权失败。', 'Model service authorization failed.');
  }
  if (e.includes('超时') || e.includes('timeout') || e.includes('timed out') || providerStatus === 408) {
    return result('E1004', '模型服务响应超时。', 'The model service timed out.');
  }
  if (e.includes('network') || e.includes('failed to fetch') || e.includes('tls') || e.includes('connection')) {
    return result('E1006', '模型服务连接失败。', 'Could not connect to the model service.');
  }
  if ((e.includes('rate') && e.includes('limit')) || providerStatus === 429) {
    return result('E1007', '模型服务当前请求过多。', 'The model service is receiving too many requests.');
  }
  if ((e.includes('required') || e.includes('minlength')) && e.includes('prompt')) {
    return result('E1008', '提示词不能为空。', 'A prompt is required.');
  }
  if ((e.includes('参数') && e.includes('拒绝')) || providerStatus === 400 || e.includes('422') || e.includes('validation') || e.includes('invalid_input') || e.includes('invalid parameter')) {
    return result('E1009', '生成参数不符合模型要求。', 'The generation parameters are not supported by this model.');
  }
  if (providerStatus === 404 || e.includes('model not found') || e.includes('模型不存在')) {
    return result('E1010', '当前模型或服务地址不可用。', 'The selected model or service endpoint is unavailable.');
  }
  if (
    e.includes('sensitivecontent')
    || e.includes('sensitive content')
    || e.includes('privacyinformation')
    || e.includes('内容审核')
    || e.includes('敏感')
  ) {
    return result('E1011', '参考素材未通过内容检查。', 'A reference asset did not pass the content check.');
  }
  if (
    providerStatus >= 500
    || e.includes('service unavailable')
    || e.includes('temporarily unavailable')
    || e.includes('upstream_unavailable')
    || e.includes('no available account')
    || e.includes('服务暂时不可用')
    || e.includes('暂无可用服务账号')
  ) {
    return result('E1012', '模型服务暂时不可用。', 'The model service is temporarily unavailable.');
  }
  if (e.includes('provider http') || e.includes('upstream')) {
    return result('E1013', '模型服务返回异常。', 'The model service returned an error.');
  }
  // Queue wrappers often include a more useful inner cause. Keep this fallback
  // after all specific classifications so users see that cause when present.
  if (e.includes('queued task failed')) {
    return result('E1005', '生成任务执行失败，系统未重复提交。', 'The queued generation task failed and was not resubmitted.');
  }
  return result('E1099', '生成未完成。', 'Generation was not completed.');
}

/** Older generic errors have no recoverable upstream reason. */
export function nodeFailureReason(error: string): string {
  const reason = safeFailureMessage(error);
  if (/^(?:模型)?服务暂时不可用[，,]?\s*请稍后重试[。.]?$/.test(reason)) {
    return "此任务只保存了通用错误，未记录具体原因。新任务将显示模型服务返回的失败原因。";
  }
  return reason;
}

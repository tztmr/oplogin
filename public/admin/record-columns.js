(function (root) {
  // Shared by the browser and CSV writer so field names and labels stay aligned.
  const columns = [
    { key: 'distributionOrder', label: '分发顺位' },
    { key: 'googleAccount', label: '谷歌号' },
    { key: 'googlePassword', label: '谷歌密码' },
    { key: 'googleAssist', label: '谷歌辅助' },
    { key: 'googleExpireAt', label: '谷歌到期时间' },
    { key: 'uidValue', label: 'UID' },
    { key: 'uidCreatedAt', label: 'UID创建时间' },
    { key: 'phoneNumber', label: '手机号' },
    { key: 'phoneExpireAt', label: '手机到期时间' },
    { key: 'phoneSmsUrl', label: '接码链接' },
    { key: 'phoneStatus', label: '手机状态' },
    { key: 'phoneModel', label: '机型' },
    { key: 'opValue', label: 'OP' },
    { key: 'opNickname', label: 'OP昵称' },
    { key: 'opLink', label: 'OP链接' },
    { key: 'opExpireAt', label: 'OP到期时间' },
    { key: 'remark', label: '备注' },
  ];
  if (typeof module === 'object' && module.exports) module.exports = columns;
  else root.AdminRecordColumns = columns;
})(typeof window === 'undefined' ? globalThis : window);

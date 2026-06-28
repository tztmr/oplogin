const GAME_OPTIONS = [
  { value: '100507190', label: '小红书' },
  { value: '1104466820', label: '王者荣耀' },
  { value: '100228415', label: '快手普通版' },
  { value: '1107805332', label: '快手极速版' },
  { value: '100392046', label: '陌陌' },
  { value: '1105602870', label: '抖音' },
  { value: '1104790111', label: '拼多多' },
  { value: '1107803357', label: '噗叽' },
  { value: '1105245568', label: '天龙八部' },
  { value: '1109838467', label: '妄想山海' },
  { value: '1106467070', label: '和平精英' },
  { value: '1104922185', label: 'QQ飞车' },
  { value: '1101070761', label: '腾讯欢乐麻将' },
  { value: '101028429', label: 'JJ斗地主' },
  { value: '205141', label: '酷狗' },
  { value: '101992353', label: '欢游' },
  { value: '100733509', label: '他趣' },
  { value: '1105200115', label: '王者营地' },
  { value: '1101083114', label: '微视' },
  { value: '100273020', label: '京东' },
  { value: '1106039633', label: '懂车帝' },
  { value: '1104512706', label: 'CFm' },
  { value: '1106087470', label: '百度极速版' },
  { value: '1105641716', label: '一起来捉妖' },
  { value: '1110543085', label: '三角洲' },
  { value: '1105764729', label: '头条极速版' },
  { value: '100290348', label: '今日头条普通版' },
  { value: '1109811436', label: '金铲铲' },
  { value: '101466002', label: '好看视频' },
  { value: '100379435', label: '腾讯地图' },
  { value: '1107594618', label: '途游斗地主' },
  { value: '1105380575', label: '西瓜视频' },
  { value: '1106838536', label: '使命召唤' },
  { value: '1105587736', label: 'QQ华夏' },
  { value: '1105376759', label: '雷速' },
  { value: '1105483033', label: 'QQ炫舞' },
  { value: '101509574', label: '赫兹' },
  { value: '1103698981', label: 'TT语音' },
  { value: '101097681', label: '全民K歌' },
  { value: '100784518', label: '百度正版' },
  { value: '100736949', label: '起点读书' },
  { value: '102042116', label: '咪鸭' },
  { value: '1104301257', label: '爱聊' },
  { value: '100512694', label: '玩吧' },
  { value: '200004', label: '优酷' },
  { value: '101528360', label: '回森' },
];

function decodeParam(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/^\/+/, ''));
  } catch {
    return String(value || '').replace(/^\/+/, '');
  }
}

function extractInitialOpValueFromLocation(locationLike) {
  const pathname = String(locationLike?.pathname || '');
  const search = String(locationLike?.search || '');
  const hash = String(locationLike?.hash || '');

  const pathParts = pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'oplogin' && pathParts[1]) {
    return decodeParam(pathParts.slice(1).join('/'));
  }

  if (search) {
    return decodeParam(search.substring(1));
  }

  if (hash) {
    return decodeParam(hash.substring(1));
  }

  return '';
}

module.exports = {
  extractInitialOpValueFromLocation,
  GAME_OPTIONS,
};

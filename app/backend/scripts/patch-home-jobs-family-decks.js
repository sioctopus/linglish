#!/usr/bin/env node
'use strict';

/**
 * 把家居 / 职业 / 家庭三套词卡写入 card-decks.json
 * （插在电器与大自然之间），并扩展电器、场景里缺的词。
 */

const fs = require('node:fs');
const path = require('node:path');

const DECKS = path.resolve(__dirname, '../../frontend/js/game/word-packs/card-decks.json');
const PHOTO = (slug, v) => '/images/game/photos/' + slug + '.jpg?v=' + (v || 1);

function w(lemma, zh, ipa, emoji, slug) {
  return {
    lemma,
    zh,
    ipa,
    emoji,
    photo: PHOTO(slug || lemma.toLowerCase().replace(/\s+/g, '-')),
  };
}

const HOME = {
  id: 'home',
  label: '家居',
  emoji: '🏠',
  words: [
    w('sofa', '沙发', '/ˈsəʊfə/', '🛋️'),
    w('armchair', '扶手椅', '/ˈɑːmtʃeə/', '🪑'),
    w('coffee table', '茶几', '/ˈkɒfi ˌteɪbl/', '🪵', 'coffee-table'),
    w('bed', '床', '/bed/', '🛏️'),
    w('pillow', '枕头', '/ˈpɪləʊ/', '🛌'),
    w('blanket', '毯子', '/ˈblæŋkɪt/', '🛏️'),
    w('curtain', '窗帘', '/ˈkɜːtn/', '🪟'),
    w('carpet', '地毯', '/ˈkɑːpɪt/', '🧶'),
    w('tile', '地砖', '/taɪl/', '🧱'),
    w('sink', '洗手台', '/sɪŋk/', '🚰'),
    w('toilet', '马桶', '/ˈtɔɪlət/', '🚽'),
    w('shower', '淋浴', '/ˈʃaʊə/', '🚿'),
    w('bathtub', '浴缸', '/ˈbɑːθtʌb/', '🛁'),
    w('mirror', '镜子', '/ˈmɪrə/', '🪞'),
    w('razor', '剃须刀', '/ˈreɪzə/', '🪒'),
    w('toothpaste', '牙膏', '/ˈtuːθpeɪst/', '🦷'),
    w('toothbrush', '牙刷', '/ˈtuːθbrʌʃ/', '🪥'),
    w('cup', '漱口杯', '/kʌp/', '🥛'),
    w('towel', '毛巾', '/ˈtaʊəl/', '🧺'),
    w('soap', '肥皂', '/səʊp/', '🧼'),
    w('shampoo', '洗发水', '/ʃæmˈpuː/', '🧴'),
    w('broom', '扫帚', '/bruːm/', '🧹'),
    w('mop', '拖把', '/mɒp/', '🧽'),
    w('trash can', '垃圾桶', '/træʃ kæn/', '🗑️', 'trash-can'),
    w('plant', '盆栽', '/plɑːnt/', '🪴'),
    w('hanger', '衣架', '/ˈhæŋə/', '👔'),
    w('remote', '遥控器', '/rɪˈməʊt/', '📺'),
    w('faucet', '水龙头', '/ˈfɔːsɪt/', '🚰'),
    w('table', '桌子', '/ˈteɪbl/', '🪵'),
    w('wardrobe', '衣柜', '/ˈwɔːdrəʊb/', '🚪'),
    w('bookshelf', '书架', '/ˈbʊkʃelf/', '📚'),
    w('cushion', '靠垫', '/ˈkʊʃn/', '🟧'),
    w('toilet paper', '卫生纸', '/ˈtɔɪlət ˌpeɪpə/', '🧻', 'toilet-paper'),
    w('tissue', '纸巾', '/ˈtɪʃuː/', '🤧'),
    w('drawer', '抽屉', '/drɔː/', '🗄️'),
    w('laundry basket', '脏衣篓', '/ˈlɔːndri ˌbɑːskɪt/', '🧺', 'laundry-basket'),
    w('cutting board', '砧板', '/ˈkʌtɪŋ bɔːd/', '🪵', 'cutting-board'),
    w('pan', '平底锅', '/pæn/', '🍳'),
    w('pot', '锅', '/pɒt/', '🍲'),
    w('plate', '盘子', '/pleɪt/', '🍽️'),
    w('bowl', '碗', '/bəʊl/', '🥣'),
    w('chopsticks', '筷子', '/ˈtʃɒpstɪks/', '🥢'),
    w('spoon', '勺子', '/spuːn/', '🥄'),
    w('fork', '叉子', '/fɔːk/', '🍴'),
    w('knife', '刀子', '/naɪf/', '🔪'),
    w('stove', '炉灶', '/stəʊv/', '🔥'),
  ],
};

const JOBS = {
  id: 'jobs',
  label: '职业',
  emoji: '🧑‍💼',
  words: [
    w('teacher', '老师', '/ˈtiːtʃə/', '👩‍🏫'),
    w('professor', '教授', '/prəˈfesə/', '👨‍🏫'),
    w('student', '学生', '/ˈstjuːdnt/', '🧑‍🎓'),
    w('doctor', '医生', '/ˈdɒktə/', '🧑‍⚕️'),
    w('nurse', '护士', '/nɜːs/', '👩‍⚕️'),
    w('dentist', '牙医', '/ˈdentɪst/', '🦷'),
    w('pharmacist', '药剂师', '/ˈfɑːməsɪst/', '💊'),
    w('chef', '厨师', '/ʃef/', '👨‍🍳'),
    w('waiter', '服务员', '/ˈweɪtə/', '🧑‍🍳'),
    w('baker', '面包师', '/ˈbeɪkə/', '🥖'),
    w('barber', '理发师', '/ˈbɑːbə/', '💇'),
    w('hairdresser', '美发师', '/ˈheədresə/', '💇‍♀️'),
    w('architect', '建筑师', '/ˈɑːkɪtekt/', '🏗️'),
    w('engineer', '工程师', '/ˌendʒɪˈnɪə/', '👷'),
    w('civil engineer', '建筑工程师', '/ˌsɪvl ˌendʒɪˈnɪə/', '🧱', 'civil-engineer'),
    w('software engineer', '软件工程师', '/ˈsɒftweə ˌendʒɪˈnɪə/', '💻', 'software-engineer'),
    w('network engineer', '网络工程师', '/ˈnetwɜːk ˌendʒɪˈnɪə/', '🛜', 'network-engineer'),
    w('pilot', '飞行员', '/ˈpaɪlət/', '✈️'),
    w('driver', '司机', '/ˈdraɪvə/', '🚌'),
    w('police officer', '警察', '/pəˈliːs ˌɒfɪsə/', '👮', 'police-officer'),
    w('firefighter', '消防员', '/ˈfaɪəfaɪtə/', '🧑‍🚒'),
    w('soldier', '士兵', '/ˈsəʊldʒə/', '🪖'),
    w('farmer', '农民', '/ˈfɑːmə/', '👨‍🌾'),
    w('fisherman', '渔民', '/ˈfɪʃəmən/', '🎣'),
    w('postman', '邮递员', '/ˈpəʊstmən/', '✉️'),
    w('journalist', '记者', '/ˈdʒɜːnəlɪst/', '🎤'),
    w('lawyer', '律师', '/ˈlɔːjə/', '⚖️'),
    w('judge', '法官', '/dʒʌdʒ/', '🧑‍⚖️'),
    w('accountant', '会计', '/əˈkaʊntənt/', '🧮'),
    w('cashier', '收银员', '/kæˈʃɪə/', '🧾'),
    w('salesperson', '销售员', '/ˈseɪlzpɜːsn/', '🛍️'),
    w('cleaner', '清洁工', '/ˈkliːnə/', '🧹'),
    w('plumber', '水管工', '/ˈplʌmə/', '🔧'),
    w('electrician', '电工', '/ɪˌlekˈtrɪʃn/', '💡'),
    w('mechanic', '修理工', '/məˈkænɪk/', '🔩'),
    w('carpenter', '木匠', '/ˈkɑːpəntə/', '🪚'),
    w('painter', '油漆工', '/ˈpeɪntə/', '🖌️', 'painter-job'),
    w('photographer', '摄影师', '/fəˈtɒɡrəfə/', '📷'),
    w('musician', '音乐家', '/mjuˈzɪʃn/', '🎵'),
    w('singer', '歌手', '/ˈsɪŋə/', '🎤'),
    w('actor', '演员', '/ˈæktə/', '🎭'),
    w('dancer', '舞蹈演员', '/ˈdɑːnsə/', '💃'),
    w('writer', '作家', '/ˈraɪtə/', '✍️'),
    w('scientist', '科学家', '/ˈsaɪəntɪst/', '🔬'),
    w('astronaut', '宇航员', '/ˈæstrənɔːt/', '👨‍🚀'),
    w('vet', '兽医', '/vet/', '🐾'),
    w('librarian', '图书管理员', '/laɪˈbreəriən/', '📚'),
    w('coach', '教练', '/kəʊtʃ/', '🏋️'),
  ],
};

const FAMILY = {
  id: 'family',
  label: '家庭',
  emoji: '👨‍👩‍👧‍👦',
  words: [
    w('family', '家庭', '/ˈfæməli/', '👨‍👩‍👧‍👦'),
    w('father', '爸爸', '/ˈfɑːðə/', '👨'),
    w('mother', '妈妈', '/ˈmʌðə/', '👩'),
    w('dad', '爹地', '/dæd/', '👨'),
    w('mom', '妈咪', '/mɒm/', '👩'),
    w('grandfather', '爷爷 / 外公', '/ˈɡrænfɑːðə/', '👴'),
    w('grandmother', '奶奶 / 外婆', '/ˈɡrænmʌðə/', '👵'),
    w('grandpa', '爷爷', '/ˈɡrænpɑː/', '👴'),
    w('grandma', '奶奶', '/ˈɡrænmɑː/', '👵'),
    w('parents', '父母', '/ˈpeərənts/', '👨‍👩‍👧'),
    w('grandparents', '祖父母', '/ˈɡrænpeərənts/', '🧓'),
    w('brother', '兄弟', '/ˈbrʌðə/', '👦'),
    w('sister', '姐妹', '/ˈsɪstə/', '👧'),
    w('older brother', '哥哥', '/ˈəʊldə ˈbrʌðə/', '🧑', 'older-brother'),
    w('older sister', '姐姐', '/ˈəʊldə ˈsɪstə/', '👩', 'older-sister'),
    w('younger brother', '弟弟', '/ˈjʌŋɡə ˈbrʌðə/', '👦', 'younger-brother'),
    w('younger sister', '妹妹', '/ˈjʌŋɡə ˈsɪstə/', '👧', 'younger-sister'),
    w('uncle', '叔叔 / 舅舅', '/ˈʌŋkl/', '👨'),
    w('aunt', '阿姨 / 姑姑', '/ɑːnt/', '👩'),
    w('cousin', '表亲 / 堂亲', '/ˈkʌzn/', '🧒'),
    w('son', '儿子', '/sʌn/', '👦'),
    w('daughter', '女儿', '/ˈdɔːtə/', '👧'),
    w('baby', '宝宝', '/ˈbeɪbi/', '👶'),
    w('husband', '丈夫', '/ˈhʌzbənd/', '👨'),
    w('wife', '妻子', '/waɪf/', '👩'),
    w('nephew', '侄子 / 外甥', '/ˈnefjuː/', '👦'),
    w('niece', '侄女 / 外甥女', '/niːs/', '👧'),
    w('relative', '亲戚', '/ˈrelətɪv/', '🧑‍🤝‍🧑'),
    w('twins', '双胞胎', '/twɪnz/', '👯'),
    w('stepfather', '继父', '/ˈstepfɑːðə/', '👨'),
    w('stepmother', '继母', '/ˈstepmʌðə/', '👩'),
  ],
};

const APPLIANCE_EXTRA = [
  w('dryer', '烘干机', '/ˈdraɪə/', '👕'),
  w('light', '灯', '/laɪt/', '💡'),
  w('switch', '开关', '/swɪtʃ/', '🔘'),
  w('socket', '插座', '/ˈsɒkɪt/', '🔌'),
  w('blender', '搅拌机', '/ˈblendə/', '🫙'),
  w('coffee maker', '咖啡机', '/ˈkɒfi ˌmeɪkə/', '☕', 'coffee-maker'),
];

const SCENE_EXTRA = [
  w('study', '书房', '/ˈstʌdi/', '📚'),
  w('balcony', '阳台', '/ˈbælkəni/', '🏢'),
  w('dining room', '餐厅', '/ˈdaɪnɪŋ ruːm/', '🍽️', 'dining-room'),
];

function main() {
  const pack = JSON.parse(fs.readFileSync(DECKS, 'utf8'));
  const decks = pack.decks;
  const byId = new Map(decks.map((d) => [d.id, d]));

  const appliances = byId.get('appliances');
  if (appliances) {
    const have = new Set(appliances.words.map((x) => x.lemma));
    APPLIANCE_EXTRA.forEach((word) => {
      if (!have.has(word.lemma)) appliances.words.push(word);
    });
  }

  const scenes = byId.get('scenes');
  if (scenes) {
    const have = new Set(scenes.words.map((x) => x.lemma));
    SCENE_EXTRA.forEach((word) => {
      if (!have.has(word.lemma)) scenes.words.push(word);
    });
  }

  // 替换或插入 home / jobs / family，顺序：电器 → 家居 → 职业 → 家庭 → 大自然
  const next = [];
  const skip = new Set(['home', 'jobs', 'family']);
  decks.forEach((deck) => {
    if (skip.has(deck.id)) return;
    next.push(deck);
    if (deck.id === 'appliances') {
      next.push(HOME, JOBS, FAMILY);
    }
  });
  if (!next.some((d) => d.id === 'home')) next.push(HOME, JOBS, FAMILY);

  pack.decks = next;
  fs.writeFileSync(DECKS, JSON.stringify(pack, null, 2) + '\n');
  console.log('decks:', pack.decks.map((d) => d.id).join(', '));
  console.log('home', HOME.words.length, 'jobs', JOBS.words.length, 'family', FAMILY.words.length);
}

main();

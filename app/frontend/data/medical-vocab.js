// Original Linglish starter course: 4 scenes, 24 bilingual lines.
// Language practice for healthcare visits; no diagnosis or treatment instructions.
window.MEDICAL_VOCAB = [
  {
    id: 'medical-appointment', tag: '预约', title: '预约并到前台报到',
    place: '到诊所说明预约时间、确认姓名', source: 'linglish-original-starter',
    words: [['appointment', '预约'], ['clinic', '诊所'], ['reception', '接待处'], ['check in', '报到']],
    turns: [
      ['Patient', 'Hi, I have an appointment at ten.', '你好，我约了十点看诊。'],
      ['Receptionist', 'Good morning. Could I have your name?', '早上好。请问你叫什么名字？'],
      ['Patient', "It's Jamie Lin. Am I in the right place?", '我叫 Jamie Lin。我是来这儿报到吗？'],
      ['Receptionist', 'Yes. This is the clinic reception.', '对。这里是诊所接待处。'],
      ['Patient', 'Thanks. Where should I wait?', '谢谢。我在哪儿等？'],
      ['Receptionist', "In the waiting room. We'll call your name.", '在候诊室等就好。我们会叫你的名字。']
    ]
  },
  {
    id: 'medical-describing-discomfort', tag: '描述', title: '说清不舒服的位置',
    place: '向医护人员描述身体部位和感受', source: 'linglish-original-starter',
    words: [['knee', '膝盖'], ['left', '左边的'], ['pain', '疼痛'], ['ankle', '脚踝']],
    turns: [
      ['Patient', 'My left knee hurts.', '我的左膝盖疼。'],
      ['Nurse', 'Could you point to where it hurts?', '你能指一下哪里疼吗？'],
      ['Patient', 'Right here. The pain started yesterday.', '就在这儿。昨天开始疼的。'],
      ['Nurse', 'Is there anything else you want to mention?', '你还有什么想补充的吗？'],
      ['Patient', 'My ankle feels sore too.', '我的脚踝也有点酸痛。'],
      ['Nurse', "Okay. I'll write that down for the doctor.", '好的。我会记下来给医生看。']
    ]
  },
  {
    id: 'medical-sharing-information', tag: '信息', title: '说明过敏和用药信息',
    place: '把自己的过敏记录和药物清单交给医护人员', source: 'linglish-original-starter',
    words: [['allergy', '过敏'], ['medicine', '药物'], ['list', '清单'], ['record', '记录']],
    turns: [
      ['Nurse', 'Do you have any allergies?', '你有什么过敏情况吗？'],
      ['Patient', "Yes. I'm allergic to penicillin.", '有。我对青霉素过敏。'],
      ['Nurse', 'Thanks for telling me. Are you taking any medicines?', '谢谢你告诉我。你目前在用什么药吗？'],
      ['Patient', 'I brought a list. Here it is.', '我带了一份清单。给你。'],
      ['Nurse', "Great. I'll add it to your record.", '好的。我会把它加到你的记录里。'],
      ['Patient', 'Could I keep a copy of that list?', '我能留一份这张清单的副本吗？']
    ]
  },
  {
    id: 'medical-asking-for-clarification', tag: '沟通', title: '没听懂时再问清楚',
    place: '请医护人员慢一点说，或写下陌生词', source: 'linglish-original-starter',
    words: [['repeat', '重复'], ['slowly', '慢慢地'], ['interpreter', '口译员'], ['question', '问题']],
    turns: [
      ['Patient', 'Sorry, could you say that more slowly?', '不好意思，你能说慢一点吗？'],
      ['Nurse', 'Of course. Which part was unclear?', '当然。你哪一部分没听清楚？'],
      ['Patient', "I don't know that word. Could you write it down?", '我不认识那个词。你能写下来吗？'],
      ['Nurse', 'Sure. Would you like an interpreter?', '可以。你需要口译员吗？'],
      ['Patient', "Yes, please. I'd feel more comfortable.", '需要，谢谢。这样我会更放心。'],
      ['Nurse', "Okay. I'll ask the front desk about that.", '好的。我去问一下前台。']
    ]
  }
];

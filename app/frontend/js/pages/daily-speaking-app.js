
    const SCENES = [
      {
        tag: '见面',
        title: '路上见面',
        place: '两个朋友在街上碰到',
        turns: [
          ['Amy', 'Hi, Ben! Long time no see.', '嗨，Ben！好久不见。'],
          ['Ben', 'Hi, Amy! How have you been?', '嗨，Amy！你近来怎么样？'],
          ['Amy', "I'm fine, thank you. And you?", '我很好，谢谢。你呢？'],
          ['Ben', "Pretty good. What's up these days?", '还不错。最近在忙什么？'],
          ['Amy', "I'm starting a new class. How about you?", '我刚开始上一个新班。你呢？'],
          ['Ben', "Same old. Let's grab a coffee sometime.", '还是老样子。找天一起喝杯咖啡吧。']
        ]
      },
      {
        tag: '见面',
        title: '初次认识',
        place: '聚会里两个人第一次说话',
        turns: [
          ['Amy', "Hi, I'm Amy. Nice to meet you.", '你好，我是 Amy。很高兴认识你。'],
          ['Ben', "Nice to meet you too. I'm Ben.", '我也很高兴认识你。我是 Ben。'],
          ['Amy', 'Where are you from?', '你从哪里来？'],
          ['Ben', "I'm from Shanghai. How about you?", '我来自上海。你呢？'],
          ['Amy', "I'm from Hangzhou. What do you do?", '我来自杭州。你做什么工作？'],
          ['Ben', "I'm a teacher. And you?", '我是老师。你呢？'],
          ['Amy', 'I work at a bookstore.', '我在一家书店工作。']
        ]
      },
      {
        tag: '见面',
        title: '聊天气',
        place: '公交站上等车，顺口聊两句',
        turns: [
          ['Amy', "It's really cold today, isn't it?", '今天真冷，是吧？'],
          ['Ben', "Yes. I didn't bring a coat.", '是啊。我没带外套。'],
          ['Amy', 'Is it going to rain later?', '待会儿会下雨吗？'],
          ['Ben', 'I think so. The sky looks pretty dark.', '我觉得会。天看起来挺暗的。'],
          ['Amy', "Then I'd better take an umbrella.", '那我最好带把伞。'],
          ['Ben', 'Good idea. I hope the bus comes soon.', '好主意。希望公交车快点来。']
        ]
      },
      {
        tag: '见面',
        title: '道别',
        place: '在朋友家坐了一会儿，准备走',
        turns: [
          ['Amy', "It's getting late. I should get going.", '时间不早了。我该走了。'],
          ['Ben', 'Already? Can you stay a little longer?', '这么快？再坐一会儿吧。'],
          ['Amy', "I'd love to, but I have an early class tomorrow.", '我也想，可我明天一早有课。'],
          ['Ben', 'Okay. Thanks for coming over.', '好吧。谢谢你过来。'],
          ['Amy', 'Thanks for dinner. It was really good.', '谢谢晚饭。真的很好吃。'],
          ['Ben', 'Anytime. Get home safe.', '随时欢迎。路上小心。'],
          ['Amy', 'I will. See you next week.', '会的。下周见。'],
          ['Ben', 'See you. Text me when you get home.', '再见。到家给我发个消息。']
        ]
      },
      {
        tag: '吃饭',
        title: '餐厅点餐',
        place: '两个人进餐厅，和服务员说话',
        turns: [
          ['Waiter', 'Good evening. A table for two?', '晚上好。两位吗？'],
          ['Amy', 'Yes, please. Can I see the menu?', '是的。可以看一下菜单吗？'],
          ['Waiter', 'Here you are. Are you ready to order?', '给您。可以点餐了吗？'],
          ['Amy', "I'd like the tomato soup and a salad.", '我要番茄汤和一份沙拉。'],
          ['Ben', "I'll have the chicken, please.", '我要鸡肉，谢谢。'],
          ['Waiter', 'Anything to drink?', '喝点什么？'],
          ['Amy', 'Two glasses of water, please.', '请给我们两杯水。'],
          ['Amy', 'Could I have the bill, please?', '请结账。'],
          ['Waiter', 'Of course. Here you are.', '好的。给您。']
        ]
      },
      {
        tag: '吃饭',
        title: '咖啡店',
        place: '在柜台点一杯咖啡',
        turns: [
          ['Barista', 'Hi. What can I get for you?', '你好。想喝点什么？'],
          ['Amy', 'A medium latte, please.', '请来一杯中杯拿铁。'],
          ['Barista', 'For here or to go?', '在这儿喝还是带走？'],
          ['Amy', 'To go, please. Can I have oat milk?', '带走。可以换成燕麦奶吗？'],
          ['Barista', 'Sure. Anything else?', '可以。还要别的吗？'],
          ['Amy', 'A blueberry muffin, please.', '再要一个蓝莓松饼。'],
          ['Barista', "That's 8.50. Your name?", '一共 8.50。怎么称呼？'],
          ['Amy', "Amy. How long will it take?", 'Amy。要等多久？'],
          ['Barista', "Just a minute. We'll call your name.", '马上就好。我们会叫你的名字。']
        ]
      },
      {
        tag: '吃饭',
        title: '预订餐位',
        place: '打电话给餐厅订今晚的位子',
        turns: [
          ['Host', 'Good afternoon. River Cafe. How can I help you?', '下午好。River Cafe。请问有什么可以帮您？'],
          ['Amy', "I'd like to book a table for tonight.", '我想订今晚的位子。'],
          ['Host', 'For how many people?', '几位？'],
          ['Amy', 'Two, around seven o\'clock.', '两位，七点左右。'],
          ['Host', 'We have 6:45 or 7:30. Which do you prefer?', '有 6:45 和 7:30。您要哪个？'],
          ['Amy', '7:30, please. The name is Amy Chen.', '7:30。名字是 Amy Chen。'],
          ['Host', "All set. We'll keep the table for fifteen minutes.", '订好了。位子会为您留十五分钟。'],
          ['Amy', 'Thank you. See you tonight.', '谢谢。今晚见。']
        ]
      },
      {
        tag: '吃饭',
        title: '说明忌口',
        place: '点餐时告诉服务员不能吃什么',
        turns: [
          ['Waiter', 'Are you ready to order?', '可以点餐了吗？'],
          ['Amy', 'Yes. Does this pasta have nuts in it?', '可以。这份意面里有坚果吗？'],
          ['Waiter', 'It has walnuts. Are you allergic?', '有核桃。您过敏吗？'],
          ['Amy', "Yes. I can't eat nuts. What do you recommend?", '是的，我不能吃坚果。你推荐什么？'],
          ['Waiter', 'The grilled fish is nut-free. It comes with rice.', '烤鱼没有坚果，配米饭。'],
          ['Amy', "I'll have that. No spicy sauce, please.", '我要这个。请不要辣酱。'],
          ['Waiter', "Of course. I'll make a note of it.", '好的。我会备注上。'],
          ['Amy', 'Thank you. I really appreciate it.', '谢谢。麻烦你了。']
        ]
      },
      {
        tag: '吃饭',
        title: '确认外卖',
        place: '外卖员在门口核对订单',
        turns: [
          ['Driver', 'Delivery for Amy. Sweet and sour chicken?', 'Amy 的外卖。糖醋鸡？'],
          ['Amy', "Yes, that's mine. Is the soup in the bag too?", '是我的。汤也在袋子里吗？'],
          ['Driver', "Yes. Be careful, it's hot.", '在。小心，很烫。'],
          ['Amy', 'Thank you. Can I check the drink?', '谢谢。我看一下饮料可以吗？'],
          ['Driver', 'Sure. One iced tea, no sugar.', '可以。一杯冰茶，不加糖。'],
          ['Amy', 'Perfect. Thank you.', '没错。谢谢。']
        ]
      },
      {
        tag: '鞋服',
        title: '美式进店',
        place: '美国门店，店员看到顾客进来',
        turns: [
          ['Clerk', 'Hey, you finding everything okay?', '嘿，都找得到吗？'],
          ['Amy', "Yeah, I'm just looking. How much is this jacket?", '嗯，我先看看。这件外套多少钱？'],
          ['Clerk', "That's 89. You wanna try it on?", '89。要试试吗？'],
          ['Amy', 'Yeah. Where are the fitting rooms?', '要。试衣间在哪？'],
          ['Clerk', "Straight back, on the left.", '一直走到后面，左边。'],
          ['Amy', 'You got this in blue?', '这个有蓝色的吗？'],
          ['Clerk', "Let me check. Yeah, we've got a medium.", '我看看。有，还有一件中号。'],
          ['Amy', "I'll take the blue one. You take cards?", '我要蓝色这件。能刷卡吗？'],
          ['Clerk', "Yep. Card's fine.", '能。刷卡就行。']
        ]
      },
      {
        tag: '鞋服',
        title: '英式进店',
        place: '英国门店，店员看到顾客进来',
        turns: [
          ['Clerk', 'Hiya. You all right there?', '嗨。还好吗，需要看看什么？'],
          ['Amy', "Yeah, just browsing. How much is this jacket?", '嗯，我随便看看。这件外套多少钱？'],
          ['Clerk', "It's 70 pounds. Do you want to try it on?", '70 英镑。要试试吗？'],
          ['Amy', 'Yes please. Where are the changing rooms?', '要。更衣室在哪？'],
          ['Clerk', "Just at the back, on the left.", '就在后面，左边。'],
          ['Amy', 'Have you got it in blue?', '有蓝色的吗？'],
          ['Clerk', "Let me have a look. Yes, we've got a medium.", '我看一下。有，还有一件中号。'],
          ['Amy', "I'll take the blue one. Can I pay by card?", '我要蓝色这件。能刷卡吗？'],
          ['Clerk', "Yes. Contactless is fine.", '能。拍卡就行。']
        ]
      },
      {
        tag: '鞋服',
        title: '美式试鞋',
        place: '美国鞋店，店员按美码帮顾客试鞋',
        turns: [
          ['Clerk', 'What size shoe are you?', '你鞋穿几码？'],
          ['Amy', "Usually an 8. Sometimes an 8 and a half.", '一般 8 码，有时 8 码半。'],
          ['Clerk', "Have a seat. I'll measure both feet.", '坐。我量一下两只脚。'],
          ['Amy', 'Are these wide, or regular?', '这双是宽楦还是正常楦？'],
          ['Clerk', 'Regular. They run a little small, so try the 8 and a half.', '正常楦。这双偏小，试 8 码半。'],
          ['Amy', "The left one's tight on my toes.", '左脚脚趾挤。'],
          ['Clerk', 'Yeah, go up half a size. Walk around a bit.', '对，大半码。走两步看看。'],
          ['Amy', 'Okay, this one feels way better.', '行，这双舒服多了。'],
          ['Clerk', 'Nice. You wanna wear them out?', '好。要直接穿着走吗？']
        ]
      },
      {
        tag: '鞋服',
        title: '英式试鞋',
        place: '英国鞋店，店员按英码帮顾客试鞋',
        turns: [
          ['Clerk', 'What size do you take?', '你穿几码？'],
          ['Amy', "A 5, sometimes a 6.", '5 码，有时 6 码。'],
          ['Clerk', "Pop yourself down. I'll measure both feet.", '坐下。我量一下两只脚。'],
          ['Amy', 'Are these wide or narrow?', '这双偏宽还是偏窄？'],
          ['Clerk', "Standard fit. They come up small, so try a 6.", '标准楦。这双偏小，试 6 码。'],
          ['Amy', 'The left one pinches my toes.', '左脚夹脚趾。'],
          ['Clerk', "Right. I'll fetch a 6. Have a little walk.", '好。我拿一双 6 码。走两步。'],
          ['Amy', "That's better. My toes have room.", '这双好点。脚趾有地方了。'],
          ['Clerk', 'Lovely. Do you want to keep them on?', '好。要直接穿着吗？']
        ]
      },
      {
        tag: '鞋服',
        title: '美式挑衣',
        place: '美国服装店，顾客找上班穿的衣服',
        turns: [
          ['Clerk', 'What are you looking for today?', '今天想找什么？'],
          ['Amy', 'Something for work. A shirt and some pants.', '上班穿的。一件衬衫，还有裤子。'],
          ['Clerk', 'Slim, or a little roomier?', '要修身的，还是宽松一点？'],
          ['Amy', "Not too tight. Cotton, if you've got it.", '别太紧。有棉的最好。'],
          ['Clerk', "This white one's cotton. Those black pants go with it.", '这件白的是棉的。那条黑裤子能配。'],
          ['Amy', 'You got the shirt in a large?', '衬衫有大号吗？'],
          ['Clerk', 'Yeah, larges are on this rack.', '有，大号在这个架子上。'],
          ['Amy', 'Can I try the shirt and the pants together?', '衬衫和裤子能一起试吗？'],
          ['Clerk', "Sure. Fitting room's on your left.", '行。试衣间在你左边。']
        ]
      },
      {
        tag: '鞋服',
        title: '英式挑衣',
        place: '英国服装店，顾客找上班穿的衣服',
        turns: [
          ['Clerk', 'What are you after today?', '今天想找什么？'],
          ['Amy', 'Something for work. A shirt and some trousers.', '上班穿的。一件衬衫，还有长裤。'],
          ['Clerk', 'Slim fit, or a bit looser?', '修身款，还是松一点？'],
          ['Amy', "Not too tight. Cotton, if you've got it.", '别太紧。有棉的最好。'],
          ['Clerk', "This white shirt's cotton. Those black trousers go with it.", '这件白衬衫是棉的。那条黑裤子能配。'],
          ['Amy', 'Have you got the shirt in a large?', '衬衫有大号吗？'],
          ['Clerk', 'Yes, the larges are on this rail.', '有，大号在这根杆上。'],
          ['Amy', 'Can I try the shirt and the trousers together?', '衬衫和裤子能一起试吗？'],
          ['Clerk', "Course. Changing room's on your left.", '可以。更衣室在你左边。']
        ]
      },
      {
        tag: '鞋服',
        title: '美式搭配',
        place: '美国门店，店员按上班场合来配',
        turns: [
          ['Clerk', 'You getting the shoes to go with that white shirt?', '鞋是配那件白衬衫的？'],
          ['Amy', 'Yeah. Do they work together?', '对。搭吗？'],
          ['Clerk', "The black ones are more office. The brown ones are casual.", '黑的更适合上班。棕色的休闲。'],
          ['Amy', 'I need them for work.', '我要上班穿。'],
          ['Clerk', "Then go with the black. A thin belt would pull it together.", '那就拿黑的。加一条细皮带就齐了。'],
          ['Amy', 'You sell belts?', '你们卖皮带吗？'],
          ['Clerk', 'Yeah, right next to the pants.', '卖，就在裤子旁边。'],
          ['Amy', "I'll grab a black one too.", '那我也拿一条黑的。']
        ]
      },
      {
        tag: '鞋服',
        title: '英式搭配',
        place: '英国门店，店员按上班场合来配',
        turns: [
          ['Clerk', 'Are the shoes for that white shirt?', '鞋是配那件白衬衫的吗？'],
          ['Amy', 'Yes. Do they go?', '是。搭吗？'],
          ['Clerk', "The black pair's smarter. The brown pair's more casual.", '黑的更正式。棕色的更休闲。'],
          ['Amy', 'I need them for the office.', '我要去办公室穿。'],
          ['Clerk', "Black, then. A thin belt would finish it off.", '那就黑的。一条细皮带就完整了。'],
          ['Amy', 'Do you sell belts?', '你们卖皮带吗？'],
          ['Clerk', 'Yes, just by the trousers.', '卖，就在裤子旁边。'],
          ['Amy', "I'll have a look at a black one.", '那我看看黑的。']
        ]
      },
      {
        tag: '鞋服',
        title: '美式优惠',
        place: '美国门店，顾客两样一起买，问能不能便宜',
        turns: [
          ['Amy', 'How much are the shoes?', '鞋多少钱？'],
          ['Clerk', "69. Shirt's 35.", '69。衬衫 35。'],
          ['Amy', 'Any deal if I get both?', '两样一起买有优惠吗？'],
          ['Clerk', 'Yeah, I can do both for 90.', '有，两样 90 我可以做。'],
          ['Amy', 'Are the shoes on sale?', '鞋在打折吗？'],
          ['Clerk', 'Just the black pair, through Sunday.', '只有这双黑的，到周日。'],
          ['Amy', "Okay, I'll take both.", '行，两样我都要。'],
          ['Clerk', "Cool. I'll hold them up front if you wanna keep looking.", '好。你再逛的话，我先放在前面。']
        ]
      },
      {
        tag: '鞋服',
        title: '英式优惠',
        place: '英国门店，顾客两样一起买，问能不能便宜',
        turns: [
          ['Amy', 'How much are the shoes?', '鞋多少钱？'],
          ['Clerk', "55 pounds. The shirt's 28.", '55 英镑。衬衫 28。'],
          ['Amy', 'Is there money off if I get both?', '两样一起买能便宜点吗？'],
          ['Clerk', 'Yes, I can do the two for 70.', '能，两样 70 英镑。'],
          ['Amy', 'Are the shoes in the sale?', '鞋在打折吗？'],
          ['Clerk', 'Only the black pair, till Sunday.', '只有这双黑的，到周日。'],
          ['Amy', "All right, I'll take both.", '行，两样我都要。'],
          ['Clerk', 'Lovely. I can keep them at the till if you want another look.', '好。你再看看的话，我先放在收银台。']
        ]
      },
      {
        tag: '鞋服',
        title: '美式缺货',
        place: '美国门店，黑色没货，店员帮顾客订',
        turns: [
          ['Amy', 'You got these in an 8, in black?', '这双有黑色 8 码吗？'],
          ['Clerk', "Black's gone. I've got brown in an 8.", '黑色没了。棕色还有 8 码。'],
          ['Amy', 'I really want the black.', '我还是想要黑色。'],
          ['Clerk', "I can order them. They'll be here in a couple days.", '我可以订。过两天到。'],
          ['Amy', "Can you text me when they're in?", '到了能发短信给我吗？'],
          ['Clerk', "Yeah. What's a good number?", '行。留个号码？'],
          ['Amy', "It's on this card. Can I put money down?", '在这张卡上。我能先付一点定金吗？'],
          ['Clerk', 'Sure. Twenty bucks holds them.', '可以。20 美元就能给你留着。']
        ]
      },
      {
        tag: '鞋服',
        title: '英式缺货',
        place: '英国门店，黑色卖完了，店员帮顾客订',
        turns: [
          ['Amy', 'Have you got these in a 5, in black?', '这双有黑色 5 码吗？'],
          ['Clerk', "Black's sold out. We've got brown in a 5.", '黑色卖完了。棕色还有 5 码。'],
          ['Amy', 'I really want the black.', '我还是想要黑色。'],
          ['Clerk', 'I can order them in. They should be here in a couple of days.', '我可以给你订。过两天该到。'],
          ['Amy', 'Can you ring me when they arrive?', '到了能打电话给我吗？'],
          ['Clerk', "Yes. What's the best number?", '可以。哪个号码方便？'],
          ['Amy', "It's on this card. Can I leave a deposit?", '在这张卡上。我能付定金吗？'],
          ['Clerk', 'Yes. Twenty pounds will hold them.', '可以。20 英镑就能给你留着。']
        ]
      },
      {
        tag: '鞋服',
        title: '美式收银',
        place: '美国收银台，顾客买好鞋和衣服',
        turns: [
          ['Clerk', "So that's the shoes, the shirt, and the belt?", '所以是鞋、衬衫，还有皮带？'],
          ['Amy', "Yep, that's it.", '对，就这些。'],
          ['Clerk', 'Card or cash?', '刷卡还是现金？'],
          ['Amy', 'Card. Can you box the shoes?', '刷卡。鞋能装盒吗？'],
          ['Clerk', 'Yeah. You want a bag for the shirt?', '行。衬衫要袋子吗？'],
          ['Amy', 'Please. And the receipt.', '要。还有小票。'],
          ['Clerk', "Here you go. You've got seven days if you need to exchange them.", '给。七天内要换都可以。'],
          ['Amy', 'Thanks. Have a good one.', '谢谢。祝你顺利。'],
          ['Clerk', 'You too.', '你也是。']
        ]
      },
      {
        tag: '鞋服',
        title: '英式收银',
        place: '英国收银台，顾客买好鞋和衣服',
        turns: [
          ['Clerk', "So that's the shoes, the shirt and the belt?", '所以是鞋、衬衫和皮带？'],
          ['Amy', "Yes, that's everything.", '对，就这些。'],
          ['Clerk', 'Card or cash?', '刷卡还是现金？'],
          ['Amy', 'Card. Could you box the shoes?', '刷卡。鞋能装盒吗？'],
          ['Clerk', 'Course. Do you want a bag for the shirt?', '可以。衬衫要袋子吗？'],
          ['Amy', 'Yes please. And the receipt.', '要。还有小票。'],
          ['Clerk', 'There you are. You can exchange them within 28 days.', '给。28 天内可以换。'],
          ['Amy', 'Thanks. Cheers.', '谢谢。'],
          ['Clerk', 'Cheers. See you again.', '好。下次见。']
        ]
      },
      {
        tag: '鞋服',
        title: '美式退换',
        place: '美国门店，衬衫小了，拿回来换',
        turns: [
          ['Clerk', 'Hey, what can I do for you?', '嘿，要办什么？'],
          ['Amy', "I got this shirt yesterday and it's too small.", '这件衬衫昨天买的，太小了。'],
          ['Clerk', 'You got the receipt?', '小票在吗？'],
          ['Amy', 'Yeah, right here. Can I swap it for a bigger size?', '在。能换大一号吗？'],
          ['Clerk', "Let me look. We've got one medium left.", '我看看。还剩一件中号。'],
          ['Amy', 'Medium should work. Can I try it?', '中号应该行。能试吗？'],
          ['Clerk', "Yeah. Fitting room's right behind you.", '能。试衣间就在你后面。'],
          ['Amy', "It fits. I'll take this one.", '合适。我要这件。'],
          ['Clerk', "Perfect. I'll fix the receipt.", '好。我改一下小票。']
        ]
      },
      {
        tag: '鞋服',
        title: '英式退换',
        place: '英国门店，衬衫小了，拿回来换',
        turns: [
          ['Clerk', 'Hi. What can I do for you?', '嗨。要办什么？'],
          ['Amy', "I bought this shirt yesterday and it's too small.", '这件衬衫昨天买的，太小了。'],
          ['Clerk', 'Have you got the receipt?', '小票在吗？'],
          ['Amy', 'Yes, here. Can I change it for a bigger size?', '在。能换大一号吗？'],
          ['Clerk', "Let me see. We've got one medium left.", '我看看。还剩一件中号。'],
          ['Amy', 'Medium should be all right. Can I try it?', '中号应该行。能试吗？'],
          ['Clerk', "Yes. The changing room's just behind you.", '能。更衣室就在你后面。'],
          ['Amy', "It fits. I'll take this one.", '合适。我要这件。'],
          ['Clerk', "Lovely. I'll sort the receipt.", '好。我处理一下小票。']
        ]
      },
      {
        tag: '购物',
        title: '超市结账',
        place: '在超市收银台',
        turns: [
          ['Cashier', 'Did you find everything you needed?', '需要的都找到了吗？'],
          ['Amy', 'Yes, thanks. Could I have a bag?', '找到了，谢谢。可以给我一个袋子吗？'],
          ['Cashier', 'Sure. Do you have a membership card?', '可以。有会员卡吗？'],
          ['Amy', "No, I don't. How much is it in total?", '没有。一共多少钱？'],
          ['Cashier', '23.40. Cash or card?', '23.40。现金还是刷卡？'],
          ['Amy', 'Card, please.', '刷卡。'],
          ['Cashier', 'Here you go. Would you like the receipt?', '给您。要小票吗？'],
          ['Amy', 'Yes, please. Thank you.', '要，谢谢。']
        ]
      },
      {
        tag: '健康',
        title: '看病',
        place: '在诊所向医生说明症状',
        turns: [
          ['Doctor', 'What brings you in today?', '今天哪里不舒服？'],
          ['Amy', "I've had a sore throat since yesterday.", '我从昨天开始嗓子疼。'],
          ['Doctor', 'Any fever or cough?', '发烧或咳嗽吗？'],
          ['Amy', 'A little cough, but no fever.', '有一点咳嗽，没有发烧。'],
          ['Doctor', 'Are you allergic to any medicine?', '对什么药过敏吗？'],
          ['Amy', 'No. How often should I take this?', '没有。这个药多久吃一次？'],
          ['Doctor', 'Twice a day, after meals. Rest and drink more water.', '一天两次，饭后吃。多休息，多喝水。'],
          ['Amy', "If I'm not better in two days, should I come back?", '如果两天没好转，我要再来吗？'],
          ['Doctor', 'Yes. Come back, or call us first.', '要。再来一趟，或者先打电话给我们。']
        ]
      },
      {
        tag: '健康',
        title: '药店',
        place: '在药店问感冒药怎么吃',
        turns: [
          ['Amy', 'Excuse me, I have a cold. What do you recommend?', '打扰一下，我感冒了。你推荐什么？'],
          ['Pharmacist', 'Do you have a headache, or just a runny nose?', '是头痛，还是只是流鼻涕？'],
          ['Amy', 'A runny nose and a sore throat.', '流鼻涕，嗓子也疼。'],
          ['Pharmacist', 'This one should help. Take one tablet every six hours.', '这个应该有用。每六小时一片。'],
          ['Amy', 'Should I take it with food?', '要和饭一起吃吗？'],
          ['Pharmacist', "Yes. Don't drive if it makes you sleepy.", '要。如果吃了犯困，就不要开车。'],
          ['Amy', 'Got it. Thank you.', '明白了。谢谢。']
        ]
      },
      {
        tag: '出行',
        title: '问路',
        place: '在路口向路人打听车站',
        turns: [
          ['Amy', 'Excuse me, where is the train station?', '打扰一下，火车站在哪里？'],
          ['Ben', 'Go straight for two blocks, then turn left.', '直走两个街区，然后左转。'],
          ['Amy', 'Is it far from here?', '离这里远吗？'],
          ['Ben', "No. It's about a ten-minute walk.", '不远。大概走十分钟。'],
          ['Amy', 'Thank you so much.', '太谢谢你了。'],
          ['Ben', "You're welcome. Have a nice day.", '不客气。祝你今天愉快。']
        ]
      },
      {
        tag: '出行',
        title: '找洗手间',
        place: '在商场里问路',
        turns: [
          ['Amy', 'Excuse me, where is the restroom?', '打扰一下，洗手间在哪里？'],
          ['Ben', "It's on the second floor, next to the elevators.", '在二楼，电梯旁边。'],
          ['Amy', 'Second floor. Are there signs?', '二楼。有指示牌吗？'],
          ['Ben', 'Yes. Follow the blue signs.', '有。跟着蓝色指示牌走。'],
          ['Amy', 'Is there one on this floor too?', '这层也有吗？'],
          ['Ben', "Yes, but it's closed for cleaning.", '有，不过正在打扫，关了。'],
          ['Amy', "Thanks. I'll go upstairs.", '谢谢。我上楼去。']
        ]
      },
      {
        tag: '出行',
        title: '打车',
        place: '上车后告诉司机要去哪里',
        turns: [
          ['Driver', 'Where to?', '去哪里？'],
          ['Amy', 'The art museum, please. Do you know it?', '请去美术馆。你知道在哪吗？'],
          ['Driver', 'Yes. The one on Park Street?', '知道。公园街那个？'],
          ['Amy', "That's right. How long will it take?", '对。要多久？'],
          ['Driver', 'About twenty minutes, if the traffic is light.', '路不堵的话，大概二十分钟。'],
          ['Amy', 'Could you drop me at the main entrance?', '能在正门让我下车吗？'],
          ['Driver', "Sure. That's 18 dollars.", '可以。十八美元。'],
          ['Amy', 'Here you are. Keep the change.', '给您。零钱不用找了。'],
          ['Driver', 'Thank you. Have a good visit.', '谢谢。参观愉快。']
        ]
      },
      {
        tag: '出行',
        title: '坐地铁',
        place: '在站厅问怎么换乘',
        turns: [
          ['Amy', 'Excuse me, which line goes to the airport?', '打扰一下，去机场坐哪条线？'],
          ['Ben', 'Take Line 2, then change to Line 7 at Central Station.', '坐 2 号线，在中央站换成 7 号线。'],
          ['Amy', 'Where do I change?', '在哪里换？'],
          ['Ben', 'Follow the green signs to Line 7.', '跟着绿色指示牌去 7 号线。'],
          ['Amy', 'How many stops is Central Station?', '中央站有几站？'],
          ['Ben', 'Four stops. The airport is the last stop on Line 7.', '四站。机场是 7 号线的终点站。'],
          ['Amy', 'Do I need a separate ticket?', '要另外买票吗？'],
          ['Ben', 'No. This card works for both lines.', '不用。这张卡两条线都能用。']
        ]
      },
      {
        tag: '出行',
        title: '买火车票',
        place: '在火车站窗口买票',
        turns: [
          ['Agent', 'Next, please. Where are you going?', '下一位。你去哪里？'],
          ['Amy', 'One ticket to Shanghai, please.', '请来一张去上海的票。'],
          ['Agent', 'For today? What time?', '今天的吗？几点？'],
          ['Amy', 'The 3:20 train, if there are seats.', '如果有座，要 3:20 那班。'],
          ['Agent', 'Window or aisle?', '靠窗还是靠过道？'],
          ['Amy', 'A window seat, please. Is it a direct train?', '靠窗。这是直达车吗？'],
          ['Agent', "Yes. It arrives at 6:05. That's 46 dollars.", '是直达。6:05 到。四十六美元。'],
          ['Amy', 'Here you are. Which platform?', '给您。在哪个站台？'],
          ['Agent', 'Platform 4. Have your ID ready.', '4 站台。身份证准备好。']
        ]
      },
      {
        tag: '出行',
        title: '机场值机',
        place: '在值机柜台办登机',
        turns: [
          ['Agent', 'Good morning. May I see your passport?', '早上好。请出示护照。'],
          ['Amy', "Here you are. I'm flying to Boston.", '给您。我飞波士顿。'],
          ['Agent', 'Any bags to check?', '有行李要托运吗？'],
          ['Amy', 'One suitcase. Can I take this backpack on the plane?', '一个箱子。这个背包可以带上飞机吗？'],
          ['Agent', 'Yes. Your gate is B12. Boarding starts at 10:40.', '可以。登机口是 B12。10:40 开始登机。'],
          ['Amy', 'Is the flight on time?', '航班准点吗？'],
          ['Agent', "Yes. It's a ten-minute walk to the gate.", '准点。走到登机口大约十分钟。'],
          ['Amy', 'Thank you. Where is security?', '谢谢。安检在哪里？'],
          ['Agent', 'Straight ahead, on your left.', '往前走，在您左手边。']
        ]
      },
      {
        tag: '办事',
        title: '酒店入住',
        place: '到酒店前台办理入住',
        turns: [
          ['Clerk', 'Welcome. Do you have a reservation?', '欢迎。您有预订吗？'],
          ['Amy', 'Yes. The name is Amy Chen.', '有。名字是 Amy Chen。'],
          ['Clerk', 'I found it. A double room for two nights.', '找到了。一间双人房，住两晚。'],
          ['Amy', 'Does it include breakfast?', '含早餐吗？'],
          ['Clerk', "Yes, from 7 to 10, on the ground floor.", '含。早上 7 点到 10 点，在一楼。'],
          ['Amy', "What's the Wi-Fi password?", 'Wi-Fi 密码是什么？'],
          ['Clerk', "It's on this card. Your room is 508.", '在这张卡上。您的房间是 508。'],
          ['Amy', 'Can I have a late checkout on Sunday?', '周日可以晚一点退房吗？'],
          ['Clerk', 'Until noon is fine. Enjoy your stay.', '到中午可以。住得愉快。']
        ]
      },
      {
        tag: '办事',
        title: '房间报修',
        place: '打电话给前台，说房间有问题',
        turns: [
          ['Clerk', 'Front desk. How can I help you?', '前台。请问有什么需要？'],
          ['Amy', "Hi, this is room 508. The air conditioner isn't working.", '你好，我是 508。空调不制冷。'],
          ['Clerk', "I'm sorry about that. Is the room very warm?", '抱歉。房间很热吗？'],
          ['Amy', 'Yes. Could someone come and take a look?', '是的。能派人来看一下吗？'],
          ['Clerk', 'Of course. Someone will be there in fifteen minutes.', '当然。十五分钟内有人过去。'],
          ['Amy', "Thank you. Also, we're out of towels.", '谢谢。另外，毛巾用完了。'],
          ['Clerk', "I'll send two clean towels with them.", '我让他们顺便带两条干净毛巾过去。'],
          ['Amy', "That's perfect. Thanks for your help.", '太好了。谢谢帮忙。']
        ]
      },
      {
        tag: '办事',
        title: '邮局寄件',
        place: '在邮局把包裹寄到国外',
        turns: [
          ['Clerk', 'What can I do for you?', '需要办什么？'],
          ['Amy', "I'd like to send this package to Canada.", '我想把这个包裹寄到加拿大。'],
          ['Clerk', "What's inside?", '里面是什么？'],
          ['Amy', 'A book and a scarf. How long will it take?', '一本书和一条围巾。要多久？'],
          ['Clerk', 'About ten days by air. By sea, it takes about a month.', '空运大约十天。海运大概要一个月。'],
          ['Amy', 'Air mail, please. Do I need to fill out a form?', '请用空运。要填表吗？'],
          ['Clerk', 'Yes. Write the address in English, please.', '要。请用英文写地址。'],
          ['Amy', 'Here you are. How much is it?', '给您。多少钱？'],
          ['Clerk', '28 dollars. Keep this tracking number.', '二十八美元。留好这个单号。']
        ]
      },
      {
        tag: '办事',
        title: '取快递',
        place: '在快递点凭取件码拿包裹',
        turns: [
          ['Staff', 'Pickup code, please.', '请说取件码。'],
          ['Amy', "It's 482916. The name is Amy Chen.", '482916。名字是 Amy Chen。'],
          ['Staff', 'One package. Can I see your phone number?', '一个包裹。可以看一下手机号吗？'],
          ['Amy', 'It ends with 3821.', '尾号是 3821。'],
          ['Staff', 'This box is open at the corner. Do you want to check it?', '这个盒子角上开了。要检查一下吗？'],
          ['Amy', "Yes. The mug inside is fine. I'll take it.", '是的。里面的杯子没事。我拿走。'],
          ['Staff', 'Please sign here.', '请在这里签名。'],
          ['Amy', 'Done. Thank you.', '好了。谢谢。']
        ]
      },
      {
        tag: '办事',
        title: '理发',
        place: '在理发店说明想怎么剪',
        turns: [
          ['Barber', 'How would you like your hair cut?', '头发想怎么剪？'],
          ['Amy', 'Just a trim, please. About two centimeters.', '稍微修一下，大约两厘米。'],
          ['Barber', 'Do you want the same style?', '发型保持不变吗？'],
          ['Amy', 'Yes, but a little shorter on the sides.', '不变，不过两侧再短一点。'],
          ['Barber', 'Would you like a wash first?', '要先洗头吗？'],
          ['Amy', 'Yes, please. How long will it take?', '要。大概要多久？'],
          ['Barber', 'About half an hour.', '大约半小时。']
        ]
      },
      {
        tag: '办事',
        title: '失物招领',
        place: '把落下的包领回来',
        turns: [
          ['Amy', 'Excuse me, I left my bag on the train.', '打扰一下，我把包落在火车上了。'],
          ['Staff', 'What does it look like?', '包长什么样？'],
          ['Amy', "It's a black backpack with a red keychain.", '黑色双肩包，挂着一个红色钥匙扣。'],
          ['Staff', 'Is your name inside?', '里面有你的名字吗？'],
          ['Amy', 'Yes, Amy Chen, and a blue notebook.', '有，Amy Chen，还有一本蓝色笔记本。'],
          ['Staff', 'I think this is it. Can you open it and check?', '应该是这个。你打开确认一下？'],
          ['Amy', 'Yes, everything is here. Thank you so much.', '是的，东西都在。太谢谢了。'],
          ['Staff', 'Glad we found it. Please sign this form.', '幸好找到了。请在这张表上签名。']
        ]
      },
      {
        tag: '相处',
        title: '约时间',
        place: '两个朋友约这周末见面',
        turns: [
          ['Ben', 'Are you free this Saturday?', '这周六你有空吗？'],
          ['Amy', 'Saturday afternoon is fine. Morning I have class.', '周六下午可以。上午我有课。'],
          ['Ben', 'How about three o\'clock at the cafe near the park?', '三点，公园旁边那家咖啡馆，怎么样？'],
          ['Amy', 'That works. Should we meet inside?', '可以。我们在里面见？'],
          ['Ben', "Yes. I'll get a table by the window.", '好。我占一个靠窗的位子。'],
          ['Amy', "Sounds good. I'll text you if I'm running late.", '好。如果我要迟到，会给你发消息。'],
          ['Ben', 'Great. See you Saturday.', '好。周六见。']
        ]
      },
      {
        tag: '相处',
        title: '改期',
        place: '临时有事，把约好的见面改到另一天',
        turns: [
          ['Amy', "Hi, Ben. I'm sorry, but I can't make it tomorrow.", '嗨，Ben。抱歉，我明天来不了。'],
          ['Ben', 'Oh, what happened?', '哦，怎么了？'],
          ['Amy', 'My sister is visiting, and I need to pick her up.', '我姐姐要来，我得去接她。'],
          ['Ben', 'No worries. Do you want to move it to Sunday?', '没关系。改到周日好吗？'],
          ['Amy', 'Sunday at three still works for me.', '周日三点我还可以。'],
          ['Ben', 'Same place?', '还是老地方？'],
          ['Amy', 'Yes. Thanks for understanding.', '对。谢谢你理解。'],
          ['Ben', 'Of course. See you Sunday.', '当然。周日见。']
        ]
      },
      {
        tag: '相处',
        title: '婉拒邀请',
        place: '朋友邀请看电影，那天已经有安排',
        turns: [
          ['Ben', "We're seeing a movie on Friday. Want to come?", '我们周五去看电影。你要来吗？'],
          ['Amy', 'Thanks for asking. I already have dinner plans.', '谢谢邀请。我那天已经约了吃饭。'],
          ['Ben', "That's okay. Maybe next time?", '没关系。下次吧？'],
          ['Amy', "I'd like that. What are you seeing?", '好啊。你们看什么？'],
          ['Ben', "A comedy at eight. I can tell you if it's good.", '八点的喜剧。好看的话我告诉你。'],
          ['Amy', 'Please do. Have fun on Friday.', '好。周五玩得开心。'],
          ['Ben', 'You too. Enjoy dinner.', '你也是。晚饭愉快。']
        ]
      },
      {
        tag: '相处',
        title: '道歉',
        place: '在咖啡馆不小心打翻了对方的杯子',
        turns: [
          ['Amy', "Oh, I'm so sorry. I spilled your coffee.", '哎呀，真对不起。我把你的咖啡打翻了。'],
          ['Ben', "It's okay. It was almost empty.", '没关系。里面差不多没了。'],
          ['Amy', 'I got some on your bag. Let me wipe it.', '溅到你的包上了。我擦一下。'],
          ['Ben', "Thanks. It's just a little.", '谢谢。只有一点点。'],
          ['Amy', 'Can I buy you another coffee?', '我再给你买一杯吧？'],
          ['Ben', "You don't have to, but that would be nice.", '不用那么客气，不过也好。'],
          ['Amy', "I'll be right back. Sorry again.", '我马上回来。再次抱歉。'],
          ['Ben', 'No harm done. Thanks.', '没造成什么损失。谢谢。']
        ]
      },
      {
        tag: '相处',
        title: '道谢',
        place: '朋友帮你搬完箱子',
        turns: [
          ['Amy', 'Thank you for helping me move these boxes.', '谢谢你帮我搬这些箱子。'],
          ['Ben', "Happy to help. They're heavier than they look.", '乐意帮忙。看着不重，其实挺沉。'],
          ['Amy', "I couldn't have done it alone. I owe you one.", '我一个人真搬不了。我欠你一次。'],
          ['Ben', "Don't mention it. Are you done for today?", '别客气。今天就这些了吗？'],
          ['Amy', 'Yes. Let me buy you lunch.', '是的。我请你吃午饭吧。'],
          ['Ben', "You don't have to.", '不用这么客气。'],
          ['Amy', "I want to. There's a noodle place downstairs.", '我想请。楼下有家面馆。'],
          ['Ben', "All right. I'm hungry anyway.", '那好。我正好饿了。']
        ]
      },
      {
        tag: '相处',
        title: '请人帮忙',
        place: '在景点请路人帮自己拍张照',
        turns: [
          ['Amy', 'Excuse me, could you take a photo of us?', '打扰一下，能帮我们拍张照吗？'],
          ['Ben', 'Sure. Which button do I press?', '可以。按哪个键？'],
          ['Amy', 'This one. Could you get the bridge in the background?', '这个。能把后面的桥也拍进去吗？'],
          ['Ben', 'Step back a little. Okay, smile.', '往后退一点。好，笑一下。'],
          ['Amy', 'Did it come out okay?', '拍清楚了吗？'],
          ['Ben', 'Yes. I took two, just in case.', '清楚。我拍了两张，以防万一。'],
          ['Amy', 'Thank you so much.', '太感谢了。'],
          ['Ben', "You're welcome. Have a good trip.", '不客气。旅途愉快。']
        ]
      },
      {
        tag: '相处',
        title: '借东西',
        place: '在教室向同学借充电器',
        turns: [
          ['Amy', 'Ben, my phone is about to die. Could I borrow your charger?', 'Ben，我手机快没电了。能借你的充电器吗？'],
          ['Ben', 'Sure. I need it back before four.', '可以。四点之前还我就行。'],
          ['Amy', "I'll give it back after this class. Is this the right plug?", '这节课下课我就还你。这个插头对吗？'],
          ['Ben', "Yes, it fits. There's an outlet by the window.", '对，能用。窗户旁边有插座。'],
          ['Amy', "Thanks. You're a lifesaver.", '谢谢。你真是救星。'],
          ['Ben', 'No problem.', '没事。']
        ]
      },
      {
        tag: '相处',
        title: '祝贺',
        place: '朋友告诉你他通过了考试',
        turns: [
          ['Ben', 'I passed the driving test!', '我驾照考试过了！'],
          ['Amy', "Congratulations! That's great news.", '恭喜！这真是好消息。'],
          ['Ben', 'Thanks. I was so nervous.', '谢谢。我当时紧张极了。'],
          ['Amy', 'You practiced a lot. You deserved it.', '你练了很久。这是你应得的。'],
          ['Ben', "We're having cake tonight. Can you come?", '我们今晚吃蛋糕。你能来吗？'],
          ['Amy', "I'd love to. What time?", '我很想来。几点？'],
          ['Ben', 'Around seven, at my place.', '七点左右，在我家。'],
          ['Amy', "I'll be there. I'm really happy for you.", '我会去的。真为你高兴。']
        ]
      },
      {
        tag: '生活',
        title: '家里来客',
        place: '朋友第一次到家里，在门口迎接',
        turns: [
          ['Amy', 'Come in. You can leave your shoes here.', '进来。鞋可以放这儿。'],
          ['Ben', 'Thanks. Something smells really good.', '谢谢。好香啊。'],
          ['Amy', 'I just made soup. Would you like tea or water?', '我刚煮了汤。你喝茶还是喝水？'],
          ['Ben', 'Tea, please. This is a nice apartment.', '喝茶。这房子真不错。'],
          ['Amy', 'Thank you. Sit anywhere you like.', '谢谢。你随便坐。'],
          ['Ben', 'Can I help with anything?', '要我帮忙吗？'],
          ['Amy', 'You can carry these bowls to the table.', '你可以把这些碗端到桌上。'],
          ['Ben', 'Happy to.', '乐意。']
        ]
      },
      {
        tag: '生活',
        title: '看电影',
        place: '在影院柜台买票',
        turns: [
          ['Clerk', 'Which movie?', '看哪一部？'],
          ['Amy', 'Two tickets for The Long Road at 7:15.', '两张 7:15 的《The Long Road》。'],
          ['Clerk', 'We have seats left in row F and row K.', 'F 排和 K 排还有位子。'],
          ['Amy', 'Row F, on the aisle, please.', '请给我 F 排靠过道的。'],
          ['Clerk', 'Here you are. Would you like a small popcorn?', '给您。要一份小份爆米花吗？'],
          ['Amy', 'Yes, and two bottles of water.', '要，再加两瓶水。'],
          ['Clerk', "That's 36 dollars. Screen 3 is down the hall.", '一共三十六美元。3 号厅在走廊尽头。'],
          ['Amy', 'What time should we go in?', '我们该几点进场？'],
          ['Clerk', 'The ads start at 7:05.', '广告 7:05 开始。']
        ]
      },
      {
        tag: '生活',
        title: '图书馆',
        place: '在图书馆借一本做饭的书',
        turns: [
          ['Librarian', 'Can I help you find something?', '需要我帮你找书吗？'],
          ['Amy', "Yes. I'm looking for a book on baking.", '要。我想找一本关于烘焙的书。'],
          ['Librarian', 'The cooking shelves are in aisle 4.', '烹饪类在第 4 排书架。'],
          ['Amy', 'Can I borrow it today?', '今天可以借走吗？'],
          ['Librarian', "Yes, with your card. It's due in three weeks.", '可以，用你的借书证。三周内还。'],
          ['Amy', 'What if I need more time?', '如果我需要更长时间呢？'],
          ['Librarian', 'You can renew it once online.', '可以在网上续借一次。'],
          ['Amy', "Perfect. I'll take this one.", '太好了。我借这本。']
        ]
      },
      {
        tag: '生活',
        title: '请一天假',
        place: '早上向主管说明明天要请假',
        turns: [
          ['Amy', 'Morning. Could I take tomorrow off?', '早上好。我明天可以请一天假吗？'],
          ['Manager', 'Is everything okay?', '没什么事吧？'],
          ['Amy', 'I have a doctor\'s appointment in the morning.', '我上午要去看医生。'],
          ['Manager', "That's fine. Can you finish the report today?", '可以。报告今天能做完吗？'],
          ['Amy', "Yes. I'll send it before I leave.", '可以。我走之前发给你。'],
          ['Manager', "Good. See you on Thursday.", '好。周四见。'],
          ['Amy', "Thank you. I'll check my email tomorrow afternoon.", '谢谢。我明天下午会看邮件。']
        ]
      },
      {
        tag: '生活',
        title: '没听清',
        place: '车站里太吵，没听清广播',
        turns: [
          ['Amy', "Sorry, I didn't catch that. Which stop is next?", '抱歉，我没听清。下一站是哪一站？'],
          ['Ben', 'Park Street. Are you getting off there?', '公园街。你在那儿下吗？'],
          ['Amy', 'No. I need the museum. Did they say it\'s closed?', '不是。我要去博物馆。他们是说关门了吗？'],
          ['Ben', 'They said the museum stop is closed today. Get off at City Hall.', '他们说博物馆站今天关闭。在市政厅下。'],
          ['Amy', 'City Hall. Could you say it one more time?', '市政厅。能再说一次吗？'],
          ['Ben', 'City Hall, two stops from here.', '市政厅，还有两站。'],
          ['Amy', "Thanks. I'll follow you if that's your stop too.", '谢谢。如果你也在那儿下，我跟着你。'],
          ['Ben', "It is. I'll tell you when we're there.", '是的。到了我叫你。']
        ]
      }
    ];

    const FIELD_TITLES = ['机场值机', '酒店入住', '餐厅点餐', '房间报修', '打车'];
    let packId = 'daily';
    let materialScenes = null;
    let accentId = savedAccent();
    let methodId = 'listen';
    let captionOn = false;
    let translateOn = false;
    try { captionOn = localStorage.getItem('linglish_caption') === '1'; } catch (_) {}
    try { translateOn = localStorage.getItem('linglish_line_translate') === '1'; } catch (_) {}
    const sentenceTranslations = new Map();
    const translatePending = new Set();
    const translateFailed = new Set();
    let translateBlocked = '';
    let sceneIndex = 0;
    let lineIndex = 0;
    const revealed = new Set();
    let recording = false;
    let playToken = 0;
    let recorder = null;
    let chunks = [];
    let mineUrl = '';
    let busy = false;
    let speakHold = false;
    let enterHeld = false;
    let speakGeneration = 0;
    let speakStopTimer = 0;
    let splitState = null;
    let splitListen = null;
    let splitRun = 0;
    let glossLine = '';
    let glossToken = 0;
    let glossParts = [];
    let glossLexicon = {};
    const glossCache = new Map();
    const POS_ZH = {
      noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词',
      pronoun: '代词', determiner: '限定词', preposition: '介词', conjunction: '连词',
      interjection: '感叹词', particle: '助词', modal: '情态', number: '数词'
    };
    const FALLBACK_POS = {
      i: 'pronoun', me: 'pronoun', you: 'pronoun', he: 'pronoun', she: 'pronoun', we: 'pronoun',
      they: 'pronoun', it: 'pronoun', my: 'pronoun', your: 'pronoun', his: 'pronoun', her: 'pronoun',
      our: 'pronoun', their: 'pronoun', him: 'pronoun', them: 'pronoun', us: 'pronoun',
      this: 'determiner', that: 'determiner', these: 'determiner', those: 'determiner',
      a: 'determiner', an: 'determiner', the: 'determiner', some: 'determiner', any: 'determiner',
      every: 'determiner', no: 'determiner', and: 'conjunction', or: 'conjunction', but: 'conjunction',
      if: 'conjunction', in: 'preposition', on: 'preposition', at: 'preposition', to: 'particle',
      for: 'preposition', of: 'preposition', with: 'preposition', from: 'preposition',
      about: 'preposition', after: 'preposition', before: 'preposition', into: 'preposition',
      over: 'preposition', under: 'preposition', without: 'preposition', during: 'preposition',
      through: 'preposition',
      is: 'verb', am: 'verb', are: 'verb', was: 'verb', were: 'verb', be: 'verb',
      have: 'verb', has: 'verb', do: 'verb', does: 'verb', did: 'verb',
      can: 'modal', could: 'modal', will: 'modal', would: 'modal', should: 'modal',
      may: 'modal', might: 'modal', must: 'modal', not: 'adverb', please: 'adverb',
      hi: 'interjection', hey: 'interjection', hello: 'interjection', bye: 'interjection',
      yes: 'interjection', yeah: 'interjection', yep: 'interjection',
      long: 'adjective', time: 'noun'
    };
    const PHRASE_START = new Set(['every', 'each', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'after', 'before', 'about', 'into', 'over', 'under', 'without', 'during', 'through']);
    const WH_WORD = new Set(['how', 'what', 'when', 'where', 'who', 'why', 'which']);
    const AUX_WORD = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must']);

    function readToken() {
      return window.AuthManager ? window.AuthManager.getToken() || '' : '';
    }

    function savedAccent() {
      try {
        const saved = localStorage.getItem('linglish_daily_accent');
        if (saved === 'us' || saved === 'uk') return saved;
      } catch (_) {}
      const meta = window.LinglishTtsVoice && LinglishTtsVoice.meta();
      return meta && meta.accent === '英式' ? 'uk' : 'us';
    }

    function sceneAccent(item) {
      if (!item || !item.title) return '';
      if (item.title.startsWith('美式')) return 'us';
      if (item.title.startsWith('英式')) return 'uk';
      return '';
    }

    function sceneName(item) {
      return String(item && item.title || '').replace(/^(美式|英式)/, '');
    }

    function matchesAccent(item) {
      const accent = sceneAccent(item);
      return !accent || accent === accentId;
    }

    function activeScenes() {
      if (packId === 'material' && materialScenes && materialScenes.length) return materialScenes;
      if (packId === 'core' && window.CORE_850) return window.CORE_850;
      if (packId === 'field') {
        return FIELD_TITLES.map((title) => SCENES.find((item) => item.title === title)).filter(Boolean);
      }
      return SCENES.filter(matchesAccent);
    }

    function pairTitle(title) {
      const bare = String(title || '').replace(/^(美式|英式)/, '');
      if (String(title || '').startsWith('美式') || String(title || '').startsWith('英式')) {
        return (accentId === 'uk' ? '英式' : '美式') + bare;
      }
      return title;
    }

    function speakLang() {
      return accentId === 'uk' ? 'en-GB' : 'en-US';
    }

    function applyAccentVoice() {
      if (!window.LinglishTtsVoice) return;
      const label = accentId === 'uk' ? '英式' : '美式';
      const now = LinglishTtsVoice.meta();
      if (now.accent === label) return;
      const match = LinglishTtsVoice.VOICES.find((item) => item.accent === label && item.gender === now.gender)
        || LinglishTtsVoice.VOICES.find((item) => item.accent === label);
      if (match) LinglishTtsVoice.set(match.voice);
    }

    function lineKey(index) {
      return packId + ':' + sceneIndex + ':' + index;
    }

    function englishShown(index) {
      return methodId !== 'speak' || revealed.has(lineKey(index));
    }

    function shadowLabel() {
      if (methodId === 'speak' && !englishShown(lineIndex)) return '我说这句';
      return '跟读';
    }

    function scene() {
      return activeScenes()[sceneIndex];
    }

    function current() {
      return scene().turns[lineIndex];
    }

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    }

    function sentenceWords(text) {
      return String(text || '').trim().split(/\s+/).filter(Boolean);
    }

    function spokenLabel(word) {
      return String(word || '').replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '') || word;
    }

    function normalizePosKey(raw) {
      const key = String(raw || '').toLowerCase().trim();
      if (!key) return '';
      if (POS_ZH[key]) return key;
      if (key.startsWith('noun') || key === 'n') return 'noun';
      if (key.startsWith('verb') || key === 'v') return 'verb';
      if (key.startsWith('adj')) return 'adjective';
      if (key.startsWith('adv')) return 'adverb';
      if (key.startsWith('pron')) return 'pronoun';
      if (key.startsWith('det') || key.startsWith('art')) return 'determiner';
      if (key.startsWith('prep')) return 'preposition';
      if (key.startsWith('conj')) return 'conjunction';
      if (key.startsWith('inter')) return 'interjection';
      if (key.startsWith('part')) return 'particle';
      if (key.startsWith('mod')) return 'modal';
      if (key.startsWith('num')) return 'number';
      return '';
    }

    function posLabel(raw) {
      const key = String(raw || '').toLowerCase().trim();
      if (POS_ZH[key]) return POS_ZH[key];
      if (key.startsWith('noun') || key === 'n') return '名词';
      if (key.startsWith('verb') || key === 'v') return '动词';
      if (key.startsWith('adj')) return '形容词';
      if (key.startsWith('adv')) return '副词';
      if (key.startsWith('pron')) return '代词';
      if (key.startsWith('det') || key.startsWith('art')) return '限定词';
      if (key.startsWith('prep')) return '介词';
      if (key.startsWith('conj')) return '连词';
      if (key.startsWith('inter')) return '感叹词';
      if (key.startsWith('part')) return '助词';
      if (key.startsWith('mod')) return '情态';
      if (key.startsWith('num')) return '数词';
      return '';
    }

    function shortZh(text) {
      const raw = String(text || '').trim();
      if (!/[\u4e00-\u9fa5]/.test(raw)) return '';
      const piece = raw.split(/[，,。；;、/]/)[0].trim();
      return piece.length > 8 ? piece.slice(0, 8) : piece;
    }

    function rawPoses(key) {
      const cached = glossCache.get(key) || {};
      const local = glossLexicon[key] || {};
      return [...new Set([cached.posKey, ...(local.poses || []), local.pos, FALLBACK_POS[key]].filter(Boolean))];
    }

    function resolvePosKey(key, index, parts) {
      if (key === 'fine') return packId === 'core' ? 'noun' : 'adjective';
      if (FALLBACK_POS[key]) return FALLBACK_POS[key];
      const poses = rawPoses(key);
      const prev = index > 0 ? spokenLabel(parts[index - 1]).toLowerCase() : '';
      const next = index + 1 < parts.length ? spokenLabel(parts[index + 1]).toLowerCase() : '';
      if (key === 'to') return rawPoses(next).includes('verb') || AUX_WORD.has(next) ? 'particle' : 'preposition';
      if (WH_WORD.has(key)) return poses.includes('adverb') ? 'adverb' : (poses.includes('pronoun') ? 'pronoun' : (poses[0] || 'adverb'));
      if (prev === 'to' && poses.includes('verb')) return 'verb';
      if (key === 'thank' && next === 'you') return 'verb';
      if (['i', 'you', 'we', 'they', 'he', 'she'].includes(prev) && poses.includes('verb')) return 'verb';
      if (poses.includes('verb') && poses.includes('noun') && ['i', 'you', 'we', 'they', 'he', 'she', 'to'].includes(prev)) return 'verb';
      return poses[0] || '';
    }

    function glossZh(key, posKey, zh) {
      if (key === 'no' && posKey === 'determiner') return '没有';
      if (packId !== 'core' && key === 'fine') return '好';
      return zh;
    }

    function glossInfo(word, index, parts) {
      const key = spokenLabel(word).toLowerCase();
      const cached = glossCache.get(key) || {};
      const local = glossLexicon[key] || {};
      const posKey = parts ? resolvePosKey(key, index, parts) : (FALLBACK_POS[key] || cached.posKey || local.pos || '');
      return {
        ipa: String(cached.ipa || local.ipa || '').replace(/[\[\]]/g, ''),
        posKey,
        pos: posLabel(posKey),
        zh: glossZh(key, posKey, cached.zh || local.zh || '')
      };
    }

    function isVerbPos(pos, key) {
      return pos === 'verb' || pos === 'modal' || AUX_WORD.has(key);
    }

    function chunkIds(parts) {
      const ids = [];
      let id = 0;
      let infinitive = false;
      let prevPos = '';
      let prevKey = '';
      parts.forEach((word, index) => {
        const key = spokenLabel(word).toLowerCase();
        const pos = resolvePosKey(key, index, parts);
        if (index > 0) {
          const phraseStart = (PHRASE_START.has(key) || WH_WORD.has(key)) && !(infinitive && key !== 'every' && key !== 'each' && !['in', 'on', 'at', 'for', 'with', 'from', 'after', 'before', 'about', 'into', 'over', 'under', 'without', 'during', 'through'].includes(key) && key !== 'to');
          const startsAdverbial = key === 'every' || key === 'each' || (PHRASE_START.has(key) && key !== 'to');
          if (infinitive && startsAdverbial) infinitive = false;
          if (key === 'to' && (rawPoses(spokenLabel(parts[index + 1] || '').toLowerCase()).includes('verb') || AUX_WORD.has(spokenLabel(parts[index + 1] || '').toLowerCase()))) {
            infinitive = true;
            id += 1;
          } else if (startsAdverbial || WH_WORD.has(key) || pos === 'interjection' || prevPos === 'interjection') {
            id += 1;
          } else if (!infinitive && isVerbPos(pos, key) && !isVerbPos(prevPos, prevKey) && prevKey !== 'to' && prevKey !== 'not') {
            id += 1;
          } else if (!infinitive && isVerbPos(prevPos, prevKey) && !isVerbPos(pos, key) && key !== 'not' && pos !== 'adverb') {
            id += 1;
          } else if (prevPos === 'noun' && (pos === 'adjective' || pos === 'determiner' || pos === 'interjection')) {
            id += 1;
          } else if (phraseStart) {
            id += 1;
          }
        }
        ids.push(id);
        prevPos = pos;
        prevKey = key;
      });
      return ids;
    }

    function hideGlossPop() {
      const pop = document.getElementById('gloss-pop');
      if (pop) pop.hidden = true;
    }

    function roleName(index, parts, kind) {
      let verbBefore = false;
      let verbAfter = false;
      parts.forEach((word, i) => {
        const key = spokenLabel(word).toLowerCase();
        const pos = resolvePosKey(key, i, parts);
        if (!isVerbPos(pos, key)) return;
        if (i < index) verbBefore = true;
        if (i > index) verbAfter = true;
      });
      if (kind === 'pronoun' && verbAfter) return '主语';
      if (verbAfter && !verbBefore) return '主语';
      if (verbBefore && !verbAfter) return '宾语';
      return kind === 'pronoun' ? '主语' : '名词';
    }

    function roleFor(index, parts, info) {
      const display = spokenLabel(parts[index]);
      const pos = info.posKey;
      const zh = info.zh;
      const prev = index > 0 ? spokenLabel(parts[index - 1]).toLowerCase() : '';
      if (display.toLowerCase() === 'to' && pos === 'particle') {
        return { zh: '不定式标记', en: 'infinitive marker', body: '助词 to，作不定式标记，用来引出后面的动词。' };
      }
      if (pos === 'verb' || pos === 'modal') {
        const role = prev === 'to' ? '不定式' : '谓语';
        const en = prev === 'to' ? 'infinitive' : 'predicate';
        const label = pos === 'modal' ? '情态动词' : '动词';
        const body = zh
          ? `${label} ${display}，作${role}，表示「${zh}」这个动作。`
          : `${label} ${display}，作${role}。`;
        return { zh: role, en, body };
      }
      if (pos === 'noun' || pos === 'pronoun') {
        const role = roleName(index, parts, pos === 'pronoun' ? 'pronoun' : 'noun');
        const en = role === '主语' ? 'subject' : role === '宾语' ? 'object' : 'noun';
        const label = pos === 'pronoun' ? '代词' : '名词';
        const body = zh ? `${label} ${display}，作${role}，表示「${zh}」。` : `${label} ${display}，作${role}。`;
        return { zh: role, en, body };
      }
      const table = {
        adjective: ['定语', 'attribute', '形容词', '作定语'],
        adverb: ['状语', 'adverbial', '副词', '作状语'],
        determiner: ['限定', 'determiner', '限定词', '用来限定后面的词'],
        preposition: ['介词', 'preposition', '介词', '用来带出后面的名词'],
        conjunction: ['连词', 'conjunction', '连词', '用来连接前后的内容'],
        interjection: ['感叹', 'interjection', '感叹词', '用来打招呼或表达情绪'],
        particle: ['助词', 'particle', '助词', ''],
        number: ['数词', 'number', '数词', '']
      };
      const item = table[pos];
      if (!item) return { zh: '词', en: 'word', body: zh ? `${display}，表示「${zh}」。` : display };
      const body = zh
        ? `${item[2]} ${display}，${item[3]}${item[3] ? '，' : ''}表示「${zh}」。`.replace('，，', '，')
        : `${item[2]} ${display}${item[3] ? `，${item[3]}` : ''}。`;
      return { zh: item[0], en: item[1], body };
    }

    function showGlossPop(index, anchor) {
      const pop = document.getElementById('gloss-pop');
      const info = glossInfo(glossParts[index], index, glossParts);
      const role = roleFor(index, glossParts, info);
      pop.innerHTML = `<p class="gloss-pop-role"><i></i>${escapeHtml(role.zh)} <em>${escapeHtml(role.en)}</em></p><p>${escapeHtml(role.body)}</p>`;
      pop.hidden = false;
      const rect = anchor.getBoundingClientRect();
      const width = pop.offsetWidth || 260;
      const height = pop.offsetHeight || 72;
      const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2));
      const top = Math.min(window.innerHeight - height - 8, rect.bottom + 8);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    }

    function paintGloss(parts, shown) {
      const row = document.getElementById('gloss-row');
      const sentence = document.getElementById('now-en');
      hideGlossPop();
      if (!shown || !parts.length) {
        row.hidden = true;
        row.innerHTML = '';
        glossParts = [];
        sentence.hidden = false;
        return;
      }
      sentence.hidden = true;
      row.hidden = false;
      glossParts = parts;
      const chunks = chunkIds(parts);
      const splitting = splitActive();
      let html = '';
      parts.forEach((word, index) => {
        const id = chunks[index];
        const prev = index > 0 ? chunks[index - 1] : -1;
        const next = index + 1 < parts.length ? chunks[index + 1] : -1;
        if (id !== prev) html += `<span class="gloss-chunk c${id % 4}">`;
        const info = glossInfo(word, index, parts);
        const state = splitting
          ? (index < splitState.index ? 'done' : index === splitState.index ? 'current' : '')
          : '';
        const edge = id !== prev && id !== next ? ' only' : id !== prev ? ' start' : id !== next ? ' end' : ' mid';
        html += `<button class="gloss-word${edge} ${state}" type="button" data-gloss="${index}"><span class="gloss-ipa">${escapeHtml(info.ipa)}</span><span class="gloss-en">${escapeHtml(spokenLabel(word))}</span><span class="gloss-pos">${escapeHtml(info.pos)}</span><span class="gloss-zh">${escapeHtml(info.zh)}</span></button>`;
        if (id !== next) html += '</span>';
      });
      row.innerHTML = html;
    }

    function ensureGloss(parts) {
      const mark = lineKey(lineIndex) + '\n' + parts.join(' ');
      if (glossLine === mark) return;
      glossLine = mark;
      const token = ++glossToken;
      const keys = [...new Set(parts.map((word) => spokenLabel(word).toLowerCase()).filter((key) => /^[a-z][a-z'-]{0,30}$/.test(key)))];
      const pending = keys.filter((key) => !glossCache.has(key));
      if (!pending.length) return;
      fetch('/dictionary/gloss?words=' + encodeURIComponent(pending.join(',')))
        .then((response) => response.ok ? response.json() : { items: [] })
        .then((data) => {
          if (token !== glossToken) return;
          const found = new Map((data.items || []).map((item) => [item.word, item]));
          pending.forEach((key) => {
            const item = found.get(key);
            glossCache.set(key, {
              ipa: item?.phonetic || '',
              posKey: normalizePosKey(item?.pos || ''),
              zh: shortZh(item?.zh || '')
            });
          });
          if (englishShown(lineIndex)) paintGloss(sentenceWords(current()[1]), true);
        })
        .catch(() => {});
    }

    function normalizeSpoken(text) {
      return String(text || '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function spokenDistance(a, b) {
      if (a === b) return 0;
      if (!a.length) return b.length;
      if (!b.length) return a.length;
      const matrix = Array.from({ length: a.length + 1 }, () => []);
      for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
      for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
      for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
        }
      }
      return matrix[a.length][b.length];
    }

    function gradeWord(word, transcript) {
      const target = normalizeSpoken(word);
      const heard = normalizeSpoken(transcript);
      if (!target || !heard) return { isCorrect: false, heard };
      if (heard === target || heard.split(' ').includes(target)) return { isCorrect: true, heard };
      const limit = Math.min(2, Math.max(1, Math.floor(target.length / 4)));
      return { isCorrect: spokenDistance(heard, target) <= limit, heard };
    }

    function splitActive() {
      return Boolean(splitState && splitState.key === lineKey(lineIndex));
    }

    function stopSplitListen() {
      const listen = splitListen;
      splitListen = null;
      if (!listen) return;
      listen.onresult = null;
      listen.onerror = null;
      listen.onend = null;
      try { listen.stop(); } catch (_) {}
    }

    function voiceFor() {
      return window.LinglishTtsVoice ? LinglishTtsVoice.current() : 'en-US-AvaMultilingualNeural';
    }

    function setStatus(text) {
      document.getElementById('status').textContent = text;
    }

    function firstSentence(text) {
      const raw = String(text || '').replace(/\s+/g, ' ').trim();
      const zh = raw.match(/^[\s\S]{8,140}?[。！？]/);
      const en = raw.match(/^[\s\S]{8,140}?(?<![A-Z])[.!?](?=\s|$)/);
      const match = zh && (!en || zh[0].length <= en[0].length) ? zh : en;
      if (match) return match[0].trim();
      return raw.length > 46 ? `${raw.slice(0, 46)}…` : raw;
    }

    function renderMaterialIndex() {
      return activeScenes().map((item, index) => {
        let group = '';
        const jumps = item.turns.map((turn, line) => {
          const mark = turn.group && turn.group !== group ? `<p class="q-group">${escapeHtml(turn.group)}</p>` : '';
          if (turn.group) group = turn.group;
          const active = index === sceneIndex && line === lineIndex ? ' active' : '';
          return `${mark}<button class="q-jump${active}" type="button" data-scene="${index}" data-line="${line}">${escapeHtml(turn[0])}</button>`;
        }).join('');
        return `<div class="chapter"><button class="line${index === sceneIndex ? ' active' : ''}" type="button" data-scene="${index}"><strong>${escapeHtml(sceneName(item))}</strong><span>${item.turns.length} 项</span></button><div class="q-list">${jumps}</div></div>`;
      }).join('');
    }

    function translationKey(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function cachedTranslation(text) {
      const key = translationKey(text);
      return key ? (sentenceTranslations.get(key) || '') : '';
    }

    function authoredTranslation(turn) {
      return translationKey(turn && turn[2]);
    }

    function sentenceSource(turn) {
      if (!turn || authoredTranslation(turn)) return '';
      return translationKey(turn.stem || turn.body || turn[1]);
    }

    function canRequestTranslation(text) {
      const key = translationKey(text);
      if (!key || key.length > 1200) return false;
      if (!/[A-Za-z]/.test(key)) return false;
      if (/[\u4e00-\u9fff]/.test(key) && !/[A-Za-z]{3,}/.test(key)) return false;
      if (sentenceTranslations.has(key) || translateFailed.has(key)) return false;
      return true;
    }

    function translationPieces(focus) {
      if (!translateOn || !focus) return [];
      const list = [];
      const sentence = sentenceSource(focus);
      if (canRequestTranslation(sentence)) list.push(sentence);
      (focus.options || []).forEach((item) => {
        if (canRequestTranslation(item)) list.push(translationKey(item));
      });
      const answer = translationKey(focus.answer);
      if (answer && !/^[A-Ea-e]$/.test(answer) && canRequestTranslation(answer)) list.push(answer);
      return [...new Set(list)];
    }

    function sentenceTranslation(turn) {
      if (!translateOn || !turn) return '';
      return authoredTranslation(turn) || cachedTranslation(turn.stem || turn.body || turn[1]);
    }

    function optionTranslation(text) {
      return translateOn ? cachedTranslation(text) : '';
    }

    function translatedMarkup(text) {
      const zh = optionTranslation(text);
      return `${escapeHtml(text)}${zh ? `<span class="choice-zh">${escapeHtml(zh)}</span>` : ''}`;
    }

    function answerTranslation(focus) {
      if (!translateOn || !focus) return '';
      const answer = translationKey(focus.answer);
      const letter = answer.match(/^([A-E])$/i);
      if (letter && Array.isArray(focus.options)) {
        const option = focus.options[letter[1].toUpperCase().charCodeAt(0) - 65];
        return option ? cachedTranslation(option) : '';
      }
      return cachedTranslation(answer);
    }

    function optionPlain(text) {
      return String(text || '').replace(/^[A-E][.、．]\s*/i, '').replace(/[.。]\s*$/, '').trim();
    }

    function correctPick(focus) {
      const answer = String(focus && focus.answer || '').trim();
      const letter = answer.match(/^([A-E])\b/i);
      if (!letter || !Array.isArray(focus.options)) return null;
      const index = letter[1].toUpperCase().charCodeAt(0) - 65;
      const text = focus.options[index];
      if (!text) return null;
      return { letter: letter[1].toUpperCase(), index, text, plain: optionPlain(text) };
    }

    function paperReason(focus) {
      const answer = String(focus && focus.answer || '').trim();
      const match = answer.match(/^[A-E][.、．\s]+(.+)$/i);
      if (!match) return '';
      const rest = match[1].trim();
      if (!rest || /^[A-E]$/i.test(rest)) return '';
      return rest;
    }

    function clipText(text, max) {
      const value = String(text || '').replace(/\s+/g, ' ').trim();
      if ([...value].length <= max) return value;
      return [...value].slice(0, max - 1).join('').trim() + '…';
    }

    const REASON_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'this', 'that', 'with', 'from', 'about', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'does', 'do', 'did', 'his', 'her', 'their', 'your', 'you', 'she', 'he', 'they', 'it']);

    function supportingSentence(optionText) {
      const words = optionPlain(optionText).toLowerCase().match(/[a-z][a-z']{3,}/g) || [];
      const keys = words.filter((word) => !REASON_STOP.has(word));
      if (!keys.length) return '';
      const turns = packId === 'material' && materialScenes
        ? materialScenes.flatMap((item) => item.turns || [])
        : ((scene() && scene().turns) || []);
      let fallback = '';
      for (const turn of turns) {
        if (!turn || turn.kind === 'question' || turn.kind === 'answer') continue;
        const body = String(turn.body || turn[1] || '');
        if (!/[A-Za-z]{4,}/.test(body)) continue;
        const sentences = body.split(/(?<=[.!?。！？])\s+/);
        for (const sentence of sentences) {
          const lower = sentence.toLowerCase();
          const hit = keys.filter((word) => lower.includes(word));
          if (!hit.length) continue;
          const line = sentence.trim();
          if (hit.length === keys.length || hit.some((word) => word.length >= 5)) return line;
          if (!fallback) fallback = line;
        }
      }
      return fallback;
    }

    function askedAbout(stem) {
      const text = String(stem || '').replace(/\s+/g, ' ').trim();
      if (/^what time\b/i.test(text)) return '时间';
      if (/\bjob\b/i.test(text) || /^what does\b.+\bdo\b/i.test(text)) return '职业';
      if (/^where\b/i.test(text)) return '地点';
      if (/^when\b/i.test(text)) return '什么时候';
      if (/^who\b/i.test(text)) return '谁';
      if (/^why\b/i.test(text)) return '原因';
      if (/^how many\b|^how much\b/i.test(text)) return '数量';
      if (/^how old\b/i.test(text)) return '年龄';
      if (/^how often\b/i.test(text)) return '频率';
      if (/^how long\b/i.test(text)) return '多久';
      if (/\banimals?\b/i.test(text)) return '哪种动物';
      return '';
    }

    function whySentence(focus) {
      if (!focus || !focus.answer || focus.kind === 'answer') return '';
      const given = paperReason(focus);
      if (given) return `为什么：${given}`;
      const picked = correctPick(focus);
      const stem = String(focus.stem || focus[1] || '').replace(/\s+/g, ' ').trim();
      if (!picked) {
        const answer = String(focus.answer).trim();
        if (!stem || !answer) return '';
        return `为什么：题目问的是「${clipText(stem, 42)}」，答案「${clipText(answer, 42)}」直接回应了这个问题。`;
      }
      const evidence = supportingSentence(picked.text);
      if (evidence) return `为什么选 ${picked.letter}：原文写着「${clipText(evidence, 72)}」，所以对应 ${picked.plain}。`;
      const about = askedAbout(stem);
      if (about) return `为什么选 ${picked.letter}：这题问的是${about}，${picked.plain} 正好回答了这一点。`;
      if (stem) return `为什么选 ${picked.letter}：题目问「${clipText(stem, 48)}」，${picked.plain} 就是在回答它。`;
      return `为什么选 ${picked.letter}：这一项是 ${picked.plain}。`;
    }

    function answerMarkup(focus) {
      const extra = answerTranslation(focus);
      const why = whySentence(focus);
      return `${escapeHtml(focus.answer || '')}${extra ? `<span class="choice-zh">${escapeHtml(extra)}</span>` : ''}${why ? `<span class="why">${escapeHtml(why)}</span>` : ''}`;
    }

    function markAnswerChoice(on) {
      const picked = correctPick(current());
      document.querySelectorAll('#exam-sheet .choice').forEach((button) => {
        button.classList.toggle('is-key', Boolean(on && picked && Number(button.dataset.choice) === picked.index));
      });
    }

    async function requestTranslation(text, token) {
      const key = translationKey(text);
      try {
        const response = await fetch('/dictionary/translate-text', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token
          },
          body: JSON.stringify({ text: key })
        });
        if (response.status === 401 || response.status === 403) {
          translateBlocked = 'login';
          return false;
        }
        const data = await response.json().catch(() => ({}));
        const translation = translationKey(data && data.translation);
        if (response.ok && data && data.success && /[\u4e00-\u9fff]/.test(translation)) {
          sentenceTranslations.set(key, translation);
          return true;
        }
        translateFailed.add(key);
        return false;
      } catch (_) {
        translateFailed.add(key);
        return false;
      }
    }

    function queueTranslations(focus) {
      if (!translateOn || translateBlocked || !focus) return;
      const needed = translationPieces(focus).filter((item) => !translatePending.has(item));
      if (!needed.length) return;
      const token = readAuthToken();
      if (!token) {
        translateBlocked = 'login';
        setStatus('登录后可以打开整句翻译。');
        return;
      }
      needed.forEach((item) => translatePending.add(item));
      const sentence = sentenceSource(focus);
      Promise.all(needed.map((text) => requestTranslation(text, token))).then((flags) => {
        needed.forEach((item) => translatePending.delete(item));
        if (!translateOn) return;
        if (translateBlocked === 'login') {
          setStatus('登录后可以打开整句翻译。');
          render();
          return;
        }
        if (flags.some(Boolean)) {
          render();
          return;
        }
        if (sentence && needed.includes(sentence)) setStatus('这句暂时没有完整翻译。');
      });
    }

    function renderExam(focus, focusShown) {
      const sheet = document.getElementById('exam-sheet');
      const nowEn = document.getElementById('now-en');
      if (!sheet) return false;
      if (packId !== 'material' || !focus || !focus.kind) {
        sheet.hidden = true;
        sheet.innerHTML = '';
        if (nowEn) nowEn.hidden = false;
        return false;
      }
      const options = (focus.options || []).map((item, index) => (
        `<button class="choice" type="button" data-choice="${index}">${translatedMarkup(item)}</button>`
      )).join('');
      const answer = focus.kind !== 'answer' && focus.answer
        ? `<button class="answer-toggle" type="button" data-answer>答案</button><p class="answer-body" id="answer-body" hidden>${answerMarkup(focus)}</p>`
        : '';
      if (focus.long && !captionOn) {
        const summary = firstSentence(focus.body || focus[1]);
        const body = escapeHtml(focus.body || focus[1]).replace(/\n/g, '<br>');
        const zh = sentenceTranslation(focus);
        const passageWaiting = !zh && translateOn && !translateBlocked && Boolean(sentenceSource(focus));
        const zhHtml = zh
          ? `<p class="now-zh passage-zh">${escapeHtml(zh)}</p>`
          : (passageWaiting ? '<p class="now-zh pending passage-zh">正在翻译…</p>' : '');
        sheet.hidden = false;
        sheet.innerHTML = `<details class="read-fold"><summary>${escapeHtml(summary)}</summary><div class="read-body">${body}</div></details>${zhHtml}${options ? `<div class="choices">${options}</div>` : ''}${answer}`;
        if (nowEn) nowEn.hidden = true;
        return true;
      }
      if (nowEn) nowEn.hidden = !focusShown;
      if (!options && !answer) {
        sheet.hidden = true;
        sheet.innerHTML = '';
        return false;
      }
      sheet.hidden = false;
      sheet.innerHTML = `${options ? `<div class="choices">${options}</div>` : ''}${answer}`;
      return false;
    }

    function turnEnglish(turn, shown) {
      if (!shown) return '<span class="covered">先自己说</span>';
      if (turn.kind === 'question') {
        const options = (turn.options || []).map((item) => `<span class="opt-line">${translatedMarkup(item)}</span>`).join('');
        return `${escapeHtml(turn.stem || turn[1])}${options ? `<span class="opt-list">${options}</span>` : ''}`;
      }
      if (turn.long) return escapeHtml(firstSentence(turn.body || turn[1]));
      return escapeHtml(turn[1]);
    }

    function captionFont(text) {
      const count = [...String(text || '')].length;
      if (count <= 28) return 40;
      if (count <= 56) return 32;
      if (count <= 110) return 26;
      if (count <= 180) return 22;
      return 18;
    }

    function applyCaption(english, chinese) {
      const now = document.getElementById('now');
      const en = document.getElementById('now-en');
      const zh = document.getElementById('now-zh');
      const toggle = document.getElementById('caption-switch');
      now.classList.toggle('caption', captionOn);
      if (toggle) {
        toggle.classList.toggle('on', captionOn);
        toggle.setAttribute('aria-pressed', captionOn ? 'true' : 'false');
      }
      const translateToggle = document.getElementById('translate-switch');
      if (translateToggle) {
        translateToggle.classList.toggle('on', translateOn);
        translateToggle.setAttribute('aria-pressed', translateOn ? 'true' : 'false');
      }
      if (!captionOn) {
        en.style.fontSize = '';
        en.style.lineHeight = '';
        zh.style.fontSize = '';
        zh.style.lineHeight = '';
        return;
      }
      const size = captionFont(english);
      en.style.fontSize = size + 'px';
      en.style.lineHeight = Math.round(size * 1.4) + 'px';
      const zhSize = Math.max(16, Math.round(size * 0.62));
      zh.style.fontSize = zhSize + 'px';
      zh.style.lineHeight = Math.round(zhSize * 1.45) + 'px';
      if (!chinese) zh.style.fontSize = '';
    }

    function render() {
      let lastTag = '';
      document.getElementById('scenes').innerHTML = packId === 'material'
        ? renderMaterialIndex()
        : activeScenes().map((item, index) => {
          const tag = item.tag !== lastTag ? `<p class="tag">${escapeHtml(item.tag)}</p>` : '';
          lastTag = item.tag;
          return `${tag}<button class="line${index === sceneIndex ? ' active' : ''}" type="button" data-scene="${index}"><strong>${escapeHtml(sceneName(item))}</strong><span>${escapeHtml(item.place)}</span></button>`;
        }).join('');
      const item = scene();
      document.getElementById('scene-title').textContent = sceneName(item);
      const words = document.getElementById('words');
      if (item.words && item.words.length) {
        words.hidden = false;
        words.innerHTML = item.words.map(([en, zh]) => `<span class="word">${escapeHtml(en)} ${escapeHtml(zh)}</span>`).join('');
        document.getElementById('scene-place').textContent = `${item.tag} · ${item.place} · ${item.words.length}个词 · ${item.turns.length}句`;
      } else {
        words.hidden = true;
        words.innerHTML = '';
        document.getElementById('scene-place').textContent = `${item.tag} · ${item.place}`;
      }
      document.getElementById('reveal-btn').hidden = methodId !== 'speak';
      const materialsBtn = document.getElementById('materials-btn');
      if (materialsBtn) materialsBtn.classList.toggle('active', packId === 'material');
      if (!recording) document.getElementById('shadow-btn').textContent = shadowLabel();
      if (splitState && splitState.key !== lineKey(lineIndex)) {
        stopSplitListen();
        splitState = null;
      }
      const focus = current();
      const parts = sentenceWords(focus[1]);
      const splitting = splitActive();
      const row = document.getElementById('split-row');
      const mic = document.getElementById('mic-btn');
      mic.hidden = captionOn || parts.length === 0;
      mic.classList.toggle('listening', Boolean(splitListen));
      mic.setAttribute('aria-pressed', splitListen ? 'true' : 'false');
      row.hidden = true;
      document.getElementById('dialogue').innerHTML = item.turns.map((turn, index) => {
        const shown = englishShown(index);
        const english = turnEnglish(turn, shown);
        const note = turn.long ? '点开阅读全文' : sentenceTranslation(turn);
        const speakIcon = (window.LxIcon && window.LxIcon.html)
          ? window.LxIcon.html('volume', { className: 'lx-icon--sm' })
          : '';
        return `<button class="turn${index === lineIndex ? ' active' : ''}" type="button" data-line="${index}"><span class="who-col"><span class="who">${escapeHtml(turn[0])}</span><span class="line-play" data-play role="img" aria-label="朗读">${speakIcon}</span></span><strong>${english}</strong><em>${escapeHtml(note)}</em></button>`;
      }).join('');
      const focusShown = englishShown(lineIndex);
      const captionEnglish = focus.body || focus[1];
      document.getElementById('now-who').textContent = focus[0];
      document.getElementById('now-en').innerHTML = focusShown
        ? escapeHtml(captionOn ? captionEnglish : (focus.long ? firstSentence(focus.body || focus[1]) : focus[1]))
        : '<span class="covered">先自己说</span>';
      const zhEl = document.getElementById('now-zh');
      if (translateOn && focusShown && !translateBlocked && !readAuthToken() && translationPieces(focus).length) {
        translateBlocked = 'login';
      }
      const sentenceZh = focusShown ? sentenceTranslation(focus) : '';
      const sentenceKey = sentenceSource(focus);
      const sentenceWaiting = Boolean(sentenceKey) && translateOn && focusShown && !translateBlocked && (translatePending.has(sentenceKey) || canRequestTranslation(sentenceKey));
      zhEl.classList.toggle('pending', !sentenceZh && sentenceWaiting);
      zhEl.textContent = examWillFold(focus) ? '' : (sentenceZh || (sentenceWaiting ? '正在翻译…' : ''));
      zhEl.hidden = !zhEl.textContent;
      applyCaption(focusShown ? captionEnglish : '', zhEl.textContent);
      const examLong = renderExam(focus, focusShown);
      const gloss = document.getElementById('gloss-row');
      if (captionOn || examLong) {
        gloss.hidden = true;
        gloss.innerHTML = '';
        mic.hidden = true;
        if (captionOn) hideGlossPop();
      } else {
        paintGloss(parts, focusShown);
        if (focusShown) ensureGloss(parts);
      }
      queueTranslations(focusShown ? focus : null);
      syncPlayLabel();
    }

    function examWillFold(focus) {
      return Boolean(focus && focus.long && !captionOn && packId === 'material' && focus.kind);
    }

    function alignWords(parts, transcript) {
      const heard = normalizeSpoken(transcript).split(' ').filter(Boolean);
      let index = 0;
      let heardIndex = 0;
      while (index < parts.length && heardIndex < heard.length) {
        if (!gradeWord(parts[index], heard[heardIndex]).isCorrect) break;
        index += 1;
        heardIndex += 1;
      }
      return { index, rest: heard.slice(heardIndex).join(' ') };
    }

    function transcriptFrom(event) {
      let finalText = '';
      let interim = '';
      let hasFinal = false;
      Array.from(event.results || []).forEach((result) => {
        const piece = result[0] && result[0].transcript;
        if (!piece) return;
        if (result.isFinal) {
          hasFinal = true;
          finalText += ' ' + piece;
        } else {
          interim = piece;
        }
      });
      return { text: (finalText + ' ' + interim).trim(), hasFinal };
    }

    function toggleMic() {
      if (splitListen) {
        splitRun += 1;
        stopSplitListen();
        render();
        setStatus('已停止。可以再点话筒。');
        return;
      }
      if (recording) {
        setStatus('正在录音。先结束跟读，再点话筒。');
        return;
      }
      if (busy) {
        setStatus('这句还在播放。点「暂停」后再点话筒。');
        return;
      }
      const parts = sentenceWords(current()[1]);
      if (!parts.length) return;
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Recognition) {
        setStatus('这个浏览器识别不了语音。可以点「播放」听，再点「跟读」。');
        return;
      }
      splitState = { key: lineKey(lineIndex), index: 0 };
      const recognition = new Recognition();
      splitListen = recognition;
      let stopped = false;
      const finishListen = () => {
        if (stopped) return;
        stopped = true;
        if (splitListen === recognition) splitListen = null;
      };
      recognition.lang = speakLang();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        if (splitListen !== recognition || !splitActive()) return;
        const spoken = transcriptFrom(event);
        const aligned = alignWords(parts, spoken.text);
        splitState.index = aligned.index;
        if (aligned.index >= parts.length) {
          revealed.add(lineKey(lineIndex));
          finishListen();
          try { recognition.stop(); } catch (_) {}
          render();
          setStatus('这句说对了。可以点「跟读」再连起来说一遍。');
          return;
        }
        if (spoken.hasFinal && aligned.rest) {
          finishListen();
          try { recognition.stop(); } catch (_) {}
          render();
          setStatus(`听成了「${aligned.rest}」。这个词是 ${spokenLabel(parts[aligned.index])}，再点话筒重说。`);
          return;
        }
        render();
        setStatus(aligned.index ? `对上了 ${aligned.index} 个词，继续说。` : '正在听。把这一句说出来。');
      };
      recognition.onerror = () => {
        if (splitListen !== recognition) return;
        finishListen();
        render();
        setStatus('没听清。再点话筒。');
      };
      recognition.onend = () => {
        const wasCurrent = splitListen === recognition;
        finishListen();
        if (!wasCurrent || !splitActive()) return;
        render();
        if (splitState.index >= parts.length) return;
        const status = document.getElementById('status').textContent;
        if (status.startsWith('听成了') || status.startsWith('这句说对了')) return;
        setStatus(splitState.index
          ? `对上了 ${splitState.index} 个词。再点话筒，从「${spokenLabel(parts[splitState.index])}」接着说。`
          : '没听清。再点话筒。');
      };
      try {
        recognition.start();
        render();
        setStatus('正在听。把这一句说出来。');
      } catch (_) {
        finishListen();
        render();
        setStatus('麦克风忙。稍后再点话筒。');
      }
    }

    function stopSpeech() {
      const lineAudio = document.getElementById('line-audio');
      if (lineAudio) {
        lineAudio.pause();
      }
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    }

    function englishVoice(voices) {
      return voices.find((voice) => /^en([-_]|$)/i.test(voice.lang) && /aria|guy|jenny|sara|davis|andrew|emma|brian|zira|david/i.test(voice.name))
        || voices.find((voice) => /^en([-_]|$)/i.test(voice.lang))
        || null;
    }

    function waitForVoices() {
      const synth = window.speechSynthesis;
      if (!synth) return Promise.resolve([]);
      const ready = synth.getVoices();
      if (ready.length) return Promise.resolve(ready);
      return new Promise((resolve) => {
        const finish = () => {
          const voices = synth.getVoices();
          if (!voices.length) return;
          synth.removeEventListener('voiceschanged', finish);
          resolve(voices);
        };
        synth.addEventListener('voiceschanged', finish);
        setTimeout(() => {
          synth.removeEventListener('voiceschanged', finish);
          resolve(synth.getVoices());
        }, 400);
      });
    }

    function speakBrowser(text, token) {
      return new Promise((resolve) => {
        const synth = window.speechSynthesis;
        if (!synth || typeof SpeechSynthesisUtterance !== 'function') {
          resolve(false);
          return;
        }
        let settled = false;
        let started = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearInterval(kick);
          resolve(ok);
        };
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = speakLang();
        utterance.rate = methodId === 'speak' ? 0.84 : 0.92;
        const voice = englishVoice(synth.getVoices());
        if (voice) utterance.voice = voice;
        const maxMs = Math.min(20000, 3500 + String(text || '').length * 120);
        const timer = setTimeout(() => finish(token === playToken && started), maxMs);
        utterance.onstart = () => { started = true; };
        utterance.onend = () => { clearTimeout(timer); finish(token === playToken); };
        utterance.onerror = () => { clearTimeout(timer); finish(false); };
        const kick = setInterval(() => {
          if (synth.paused) synth.resume();
        }, 400);
        const lineAudio = document.getElementById('line-audio');
        const lineRow = document.getElementById('line-audio-row');
        if (lineAudio) lineAudio.pause();
        if (lineRow) lineRow.hidden = true;
        setTimeout(() => {
          if (synth.paused) synth.resume();
          synth.speak(utterance);
        }, 60);
      });
    }

    function playUrl(url, token) {
      return new Promise((resolve) => {
        const audio = document.getElementById('line-audio');
        if (!audio) {
          resolve(false);
          return;
        }
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        audio.dataset.playToken = String(token);
        const lineRow = document.getElementById('line-audio-row');
        if (lineRow) lineRow.hidden = false;
        const timer = setTimeout(() => finish(true), 20000);
        const watch = setInterval(() => {
          if (token !== playToken) {
            clearInterval(watch);
            clearTimeout(timer);
            if (audio.dataset.playToken === String(token)) audio.pause();
            finish(false);
          }
        }, 200);
        audio.onended = () => { clearInterval(watch); clearTimeout(timer); finish(true); };
        audio.onerror = () => { clearInterval(watch); clearTimeout(timer); finish(false); };
        audio.src = url;
        audio.play().catch(() => { clearTimeout(timer); finish(false); });
      });
    }

    async function fetchPracticeAudio(text, voice) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch('/tts/practice', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: voice || voiceFor() }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.audioUrl) return data.audioUrl;
      } catch (_) {} finally {
        clearTimeout(timer);
      }
      return '';
    }

    async function speak(text, voice) {
      const token = playToken;
      stopSpeech();
      const practiceUrl = await fetchPracticeAudio(text, voice);
      if (token !== playToken) return false;
      if (practiceUrl && await playUrl(practiceUrl, token)) return true;
      if (token !== playToken) return false;
      await waitForVoices();
      if (token !== playToken) return false;
      const authToken = readToken();
      if (authToken) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch('/tts/generate', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + authToken,
            },
            body: JSON.stringify({ text, lang: 'en', provider: 'edge', voice: voice || voiceFor() }),
          });
          const data = await response.json().catch(() => ({}));
          if (token !== playToken) return false;
          if (response.ok && data.audioUrl && await playUrl(data.audioUrl, token)) return true;
        } catch (_) {} finally {
          clearTimeout(timer);
        }
      }
      if (token !== playToken) return false;
      return speakBrowser(text, token);
    }

    function syncPlayLabel() {
      const button = document.getElementById('play-btn');
      if (!button) return;
      button.textContent = busy && !recording ? '暂停' : '播放';
    }

    function setSpeakButtons(disabled) {
      document.getElementById('read-btn').disabled = disabled;
      document.getElementById('prev-btn').disabled = disabled;
      document.getElementById('next-btn').disabled = disabled;
      const play = document.getElementById('play-btn');
      if (play && !recording) play.textContent = disabled ? '暂停' : '播放';
    }

    function haltPlayback() {
      playToken += 1;
      splitRun += 1;
      stopSplitListen();
      stopSpeech();
      busy = false;
      const review = document.getElementById('review-btn');
      if (review) review.disabled = false;
      speakGeneration += 1;
      speakHold = false;
      clearTimeout(speakStopTimer);
      const shadow = document.getElementById('shadow-btn');
      if (shadow && !recording) {
        shadow.disabled = false;
        shadow.classList.remove('holding');
        shadow.textContent = shadowLabel();
      }
      setSpeakButtons(false);
    }

    async function playCurrent() {
      if (recording) {
        setStatus('正在录音。先结束跟读，再播放。');
        return;
      }
      if (busy) return;
      if (methodId === 'speak') {
        revealed.add(lineKey(lineIndex));
        render();
      }
      const token = ++playToken;
      busy = true;
      setSpeakButtons(true);
      const turn = current();
      setStatus(`正在播放 ${turn[0]} 的这句…`);
      const heard = await speak(turn.speak || turn[1], voiceFor(turn[0]));
      if (token !== playToken) return;
      setStatus(heard ? '这句播放完了。可以再听一次，或跟读。' : '没有播出来。再点一次「播放」。');
      setSpeakButtons(false);
      busy = false;
    }

    async function readAloud() {
      if (busy || recording) return;
      const token = ++playToken;
      busy = true;
      setSpeakButtons(true);
      const turns = scene().turns;
      let heard = true;
      for (let index = 0; index < turns.length; index += 1) {
        if (token !== playToken) return;
        lineIndex = index;
        if (methodId === 'speak') revealed.add(lineKey(index));
        render();
        setStatus(`正在朗读 ${turns[index][0]} 的这句…`);
        heard = await speak(turns[index].speak || turns[index][1], voiceFor(turns[index][0]));
        if (token !== playToken) return;
        if (!heard) break;
      }
      setStatus(heard ? '整段对话读完了。可以点一句跟读。' : '朗读中断了。再点一次「播放」。');
      setSpeakButtons(false);
      busy = false;
    }

    async function stopRecording() {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    }

    async function openMic(button, playAfter) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus('这台设备不能录音。可以点「看原句」，或切回「先听再跟」。');
        button.disabled = false;
        setSpeakButtons(false);
        busy = false;
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const spoken = current();
        chunks = [];
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = async () => {
          clearTimeout(speakStopTimer);
          speakStopTimer = 0;
          button.classList.remove('holding');
          stream.getTracks().forEach(track => track.stop());
          if (mineUrl) URL.revokeObjectURL(mineUrl);
          mineUrl = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
          const mine = document.getElementById('mine-audio');
          mine.src = mineUrl;
          const mineRow = document.getElementById('mine-audio-row');
          if (mineRow) mineRow.hidden = false;
          document.getElementById('mine-btn').disabled = false;
          recording = false;
          busy = false;
          button.disabled = false;
          setSpeakButtons(false);
          if (playAfter) {
            revealed.add(lineKey(lineIndex));
            render();
            const token = ++playToken;
            busy = true;
            button.disabled = true;
            setSpeakButtons(true);
            setStatus('这是原句。正在播放…');
            const heard = await speak(spoken[1], voiceFor(spoken[0]));
            if (token !== playToken) return;
            busy = false;
            button.disabled = false;
            setSpeakButtons(false);
            button.textContent = shadowLabel();
            setStatus(heard ? '原句听完了。要再跟一次，点「跟读这句」。' : '原句没有播出来。点「播放这句」再听一次。');
            return;
          }
          button.textContent = shadowLabel();
          button.classList.remove('holding');
          setStatus('这句跟读已录好。可以听自己的录音，或练下一句。');
        };
        recorder.start();
        recording = true;
        busy = false;
        button.disabled = false;
        noteSpeakReady(button);
      } catch (_) {
        setStatus('没有打开麦克风。可以点「看原句」，或切回「先听再跟」。');
        button.disabled = false;
        setSpeakButtons(false);
        busy = false;
      }
    }

    function speakBufferMs() {
      const words = Math.max(1, sentenceWords(current()[1]).length);
      return Math.min(8000, Math.max(2200, 900 + words * 380));
    }

    function noteSpeakReady(button) {
      clearTimeout(speakStopTimer);
      if (speakHold) {
        button.classList.add('holding');
        button.textContent = '松开结束';
        setStatus('按住说。松开就结束。');
        return;
      }
      button.classList.remove('holding');
      button.textContent = '说完了';
      const seconds = Math.max(1, Math.round(speakBufferMs() / 1000));
      setStatus(`说吧。${seconds} 秒后自动结束。`);
      speakStopTimer = setTimeout(() => {
        if (recording && !speakHold) finishSpeak();
      }, speakBufferMs());
    }

    async function finishSpeak() {
      clearTimeout(speakStopTimer);
      speakStopTimer = 0;
      speakHold = false;
      const button = document.getElementById('shadow-btn');
      button.classList.remove('holding');
      if (!recording) {
        button.disabled = false;
        button.textContent = shadowLabel();
        return;
      }
      button.disabled = true;
      setStatus('正在保存录音…');
      await stopRecording();
    }

    function onSpeakPress() {
      const button = document.getElementById('shadow-btn');
      if (recording) {
        speakHold = true;
        clearTimeout(speakStopTimer);
        button.classList.add('holding');
        button.textContent = '松开结束';
        return;
      }
      if (busy) return;
      speakHold = true;
      button.classList.add('holding');
      startShadow();
    }

    function onSpeakRelease() {
      if (!speakHold) return;
      speakHold = false;
      const button = document.getElementById('shadow-btn');
      button.classList.remove('holding');
      if (recording) finishSpeak();
    }

    async function startShadow() {
      splitRun += 1;
      stopSplitListen();
      const button = document.getElementById('shadow-btn');
      const generation = ++speakGeneration;
      if (recording || busy) return;
      const hearFirst = methodId !== 'speak' || englishShown(lineIndex);
      if (hearFirst) {
        const token = ++playToken;
        busy = true;
        setSpeakButtons(true);
        setStatus(`先听 ${current()[0]} 说一遍，然后跟着说。`);
        const heard = await speak(current()[1], voiceFor(current()[0]));
        if (token !== playToken || generation !== speakGeneration) {
          button.disabled = false;
          button.classList.remove('holding');
          button.textContent = shadowLabel();
          return;
        }
        if (!heard) setStatus('原句没有播出来。麦克风打开后，你仍可以跟着说。');
        setSpeakButtons(false);
      }
      if (generation !== speakGeneration) return;
      await openMic(button, !hearFirst);
    }

    function releasePlayback() {
      if (!busy) return;
      haltPlayback();
    }

    function loadCorePack() {
      if (window.CORE_850 && window.CORE_850.length) return Promise.resolve(true);
      return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = './data/core-850.js?v=2';
        script.onload = () => resolve(Boolean(window.CORE_850 && window.CORE_850.length));
        script.onerror = () => resolve(false);
        document.body.appendChild(script);
      });
    }

    document.getElementById('packs').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-pack]');
      if (!button) return;
      if (recording) {
        setStatus('正在录音。先结束跟读，再打开 850 词。');
        return;
      }
      const nextPack = button.dataset.pack;
      const coreReady = Boolean(window.CORE_850 && window.CORE_850.length);
      if (nextPack === packId && (nextPack !== 'core' || coreReady)) return;
      releasePlayback();
      if (nextPack === 'core' && !coreReady) {
        setStatus('正在打开 850 词…');
        const loaded = await loadCorePack();
        if (!loaded) {
          setStatus('850 词没有加载成功。请刷新页面后再点一次「850词」。');
          return;
        }
      }
      packId = nextPack;
      sceneIndex = 0;
      lineIndex = 0;
      if (location.search.includes('material=') && nextPack !== 'material') {
        history.replaceState(null, '', './daily-speaking.html');
      }
      document.querySelectorAll('.pack').forEach((el) => el.classList.toggle('active', el === button));
      document.querySelector('[data-pack="field"]').classList.remove('active');
      document.getElementById('review').hidden = true;
      stopSpeech();
      render();
      const sceneList = document.getElementById('scenes');
      sceneList.scrollTop = 0;
      const count = activeScenes().length;
      setStatus(packId === 'core' ? `已经打开 850 词：${count} 个场景，1746 句。左边从「01 我是谁」开始。` : '回到日常场景。选一段开始。');
    });

    document.getElementById('exam-sheet').addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-answer]');
      if (toggle) {
        const body = document.getElementById('answer-body');
        if (!body) return;
        body.hidden = !body.hidden;
        toggle.textContent = body.hidden ? '答案' : '收起答案';
        markAnswerChoice(!body.hidden);
        if (!body.hidden) {
          const why = whySentence(current());
          if (why) setStatus(why);
        }
        return;
      }
      const choice = event.target.closest('[data-choice]');
      if (!choice || busy || recording) return;
      const focus = current();
      const option = (focus.options || [])[Number(choice.dataset.choice)];
      const picked = correctPick(focus);
      if (picked && Number(choice.dataset.choice) === picked.index) {
        const body = document.getElementById('answer-body');
        const answerButton = document.querySelector('#exam-sheet [data-answer]');
        if (body) body.hidden = false;
        if (answerButton) answerButton.textContent = '收起答案';
        markAnswerChoice(true);
        const why = whySentence(focus);
        if (why) setStatus(why);
      }
      if (option) speak(option, voiceFor());
    });

    document.getElementById('scenes').addEventListener('click', (event) => {
      const jump = event.target.closest('[data-line]');
      const button = jump || event.target.closest('[data-scene]');
      if (!button) return;
      if (recording) {
        setStatus('正在录音。先结束跟读，再换一段。');
        return;
      }
      releasePlayback();
      sceneIndex = Number(button.dataset.scene);
      lineIndex = jump ? Number(button.dataset.line) : 0;
      document.getElementById('review').hidden = true;
      render();
      const active = document.querySelector('#scenes .q-jump.active') || document.querySelector('#scenes .line.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
      const opened = current();
      if (packId === 'material' && jump) {
        setStatus(opened.long
          ? `已打开「${opened[0]}」。先看这一句，点开再读全文。`
          : opened.kind === 'question'
            ? `已打开「${opened[0]}」。题目在上，选项在下，答案点开再看。`
            : `已打开「${opened[0]}」。可以点「播放」。`);
        return;
      }
      setStatus(methodId === 'speak'
        ? `已打开「${sceneName(scene())}」。先看中文，自己说高亮这一句。`
        : `已打开「${sceneName(scene())}」。可以点「播放这句」。`);
    });

    document.getElementById('gloss-row').addEventListener('click', (event) => {
      const word = event.target.closest('[data-gloss]');
      if (!word) return;
      event.stopPropagation();
      showGlossPop(Number(word.dataset.gloss), word);
    });
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-gloss]') || event.target.closest('#gloss-pop')) return;
      hideGlossPop();
    });

    function loadGlossLexicon() {
      fetch('/data/gloss-lexicon.json?v=3')
        .then((response) => response.ok ? response.json() : {})
        .then((data) => {
          glossLexicon = data && typeof data === 'object' ? data : {};
          if (englishShown(lineIndex)) paintGloss(sentenceWords(current()[1]), true);
        })
        .catch(() => {});
    }

    document.getElementById('dialogue').addEventListener('click', (event) => {
      const button = event.target.closest('[data-line]');
      if (!button || recording) return;
      const wantsPlay = Boolean(event.target.closest('[data-play]'));
      lineIndex = Number(button.dataset.line);
      render();
      if (wantsPlay) {
        playCurrent();
        return;
      }
      setStatus(methodId === 'speak' && !englishShown(lineIndex)
        ? '先看中文自己说。要听原句，点名字下面的喇叭。'
        : `准备跟读 ${current()[0]} 的这句。点名字下面的喇叭可以听。`);
    });

    document.getElementById('caption-switch').addEventListener('click', () => {
      captionOn = !captionOn;
      try { localStorage.setItem('linglish_caption', captionOn ? '1' : '0'); } catch (_) {}
      hideGlossPop();
      render();
      setStatus(captionOn
        ? (translateOn ? '纯字幕。上面是英文，下面是整句翻译。' : '纯字幕。上面只留英文。')
        : '拆词打开了。点词可以看词性。');
    });

    document.getElementById('translate-switch').addEventListener('click', () => {
      translateOn = !translateOn;
      if (translateOn) {
        translateBlocked = '';
        translateFailed.clear();
      }
      try { localStorage.setItem('linglish_line_translate', translateOn ? '1' : '0'); } catch (_) {}
      render();
      setStatus(translateBlocked === 'login'
        ? '登录后可以打开整句翻译。'
        : (translateOn ? '整句翻译打开了。句子和选项都会显示完整中文。' : '整句翻译关掉了。'));
    });

    document.getElementById('methods').addEventListener('click', (event) => {
      const methodButton = event.target.closest('[data-method]');
      const fieldButton = event.target.closest('[data-pack="field"]');
      if (recording || busy) return;
      if (fieldButton) {
        packId = packId === 'field' ? 'daily' : 'field';
        methodId = packId === 'field' ? 'speak' : methodId;
        sceneIndex = 0;
        lineIndex = 0;
        if (location.search.includes('material=')) history.replaceState(null, '', './daily-speaking.html');
        document.querySelectorAll('.pack').forEach((el) => el.classList.toggle('active', el.dataset.pack === packId));
        document.querySelector('[data-pack="field"]').classList.toggle('active', packId === 'field');
        document.getElementById('review').hidden = true;
        render();
        syncMethodButtons();
        setStatus(packId === 'field' ? '从机场值机开始。一次只说一句。' : '回到全部日常场景。');
        return;
      }
      if (!methodButton || methodButton.dataset.method === methodId) return;
      methodId = methodButton.dataset.method;
      document.getElementById('review').hidden = true;
      syncMethodButtons();
      render();
      setStatus(methodId === 'speak' ? '英文先藏起来。看中文，自己说。' : '原句都打开了。可以先听再跟。');
    });

    function syncMethodButtons() {
      document.querySelectorAll('[data-method]').forEach((el) => {
        el.classList.toggle('active', el.dataset.method === methodId);
      });
    }

    function reviewIndexes(turns) {
      if (turns.length <= 3) return turns.map((_, index) => index);
      const mid = Math.floor((turns.length - 1) / 2);
      return [0, mid, turns.length - 1];
    }

    async function reviewThree() {
      if (busy || recording) return;
      const turns = scene().turns;
      const indexes = reviewIndexes(turns);
      const box = document.getElementById('review');
      box.hidden = false;
      box.innerHTML = '<p>这段只带走这三句。再说一遍，不讲语法。</p><ol>' + indexes.map((index) => (
        `<li><strong>${escapeHtml(turns[index][1])}</strong><em>${escapeHtml(turns[index][2])}</em></li>`
      )).join('') + '</ol>';
      indexes.forEach((index) => revealed.add(lineKey(index)));
      const token = ++playToken;
      busy = true;
      document.getElementById('review-btn').disabled = true;
      setSpeakButtons(true);
      for (const index of indexes) {
        if (token !== playToken) return;
        lineIndex = index;
        render();
        setStatus(`跟着说：${turns[index][1]}`);
        await speak(turns[index][1], voiceFor(turns[index][0]));
        if (token !== playToken) return;
      }
      setStatus('三句说完就可以换下一段。');
      document.getElementById('review-btn').disabled = false;
      setSpeakButtons(false);
      busy = false;
    }

    function revealCurrent() {
      playCurrent();
    }

    async function nextLine() {
      if (busy || recording) return;
      const total = scene().turns.length;
      if (methodId === 'speak') {
        if (!englishShown(lineIndex)) {
          setStatus('这一句还没说。先看中文，说完再点「看原句」。');
          return;
        }
        if (lineIndex >= total - 1) {
          await reviewThree();
          return;
        }
        lineIndex += 1;
        document.getElementById('review').hidden = true;
        render();
        const active = document.querySelector('#dialogue .turn.active');
        if (active) active.scrollIntoView({ block: 'nearest' });
        setStatus('下一句。先看中文，自己说。');
        return;
      }
      lineIndex = lineIndex + 1 < total ? lineIndex + 1 : 0;
      render();
      const active = document.querySelector('#dialogue .turn.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
      const token = ++playToken;
      busy = true;
      setSpeakButtons(true);
      const turn = current();
      setStatus(lineIndex === 0 && total > 1
        ? `这段到头了，回到第一句：${turn[0]}`
        : `下一句：${turn[0]}`);
      const heard = await speak(turn.speak || turn[1], voiceFor(turn[0]));
      if (token !== playToken) return;
      setStatus(heard ? '这句读完了。可以跟读，或再点下一句。' : '这句没有播出来。点「播放」再听一次。');
      setSpeakButtons(false);
      busy = false;
    }

    async function prevLine() {
      if (busy || recording) return;
      if (lineIndex <= 0) {
        setStatus('这已经是第一句。');
        return;
      }
      lineIndex -= 1;
      document.getElementById('review').hidden = true;
      render();
      const active = document.querySelector('#dialogue .turn.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
      if (methodId === 'speak') {
        setStatus('上一句。先看中文，自己说。');
        return;
      }
      const token = ++playToken;
      busy = true;
      setSpeakButtons(true);
      const turn = current();
      setStatus(`上一句：${turn[0]}`);
      const heard = await speak(turn.speak || turn[1], voiceFor(turn[0]));
      if (token !== playToken) return;
      setStatus(heard ? '这句读完了。可以跟读，或再点上一句。' : '这句没有播出来。点「播放」再听一次。');
      setSpeakButtons(false);
      busy = false;
    }

    document.getElementById('play-btn').addEventListener('click', () => {
      if (recording) {
        setStatus('正在录音。先结束跟读，再播放。');
        return;
      }
      const playing = document.getElementById('play-btn').textContent === '暂停';
      if (busy || playing) {
        haltPlayback();
        setStatus('已暂停。');
        return;
      }
      playCurrent();
    });
    document.getElementById('read-btn').addEventListener('click', readAloud);
    function openSceneIntensiveNote(mode) {
      if (!window.WorkbenchImport) {
        setStatus('精读笔记组件未加载。');
        return;
      }
      const item = scene();
      const turn = current();
      const text = mode === 'line'
        ? String(turn?.[1] || '').trim()
        : (item?.turns || []).map((row) => String(row?.[1] || '').trim()).filter(Boolean).join(' ');
      const ok = window.WorkbenchImport.openIntensiveNote({
        text,
        title: sceneName(item) || '日常用语',
        template: 'intensive-note',
        orient: 'story',
        source: 'daily-speaking',
        onEmpty: () => setStatus(mode === 'line' ? '当前没有可导出的英文句子。' : '当前场景没有英文句子。'),
      });
      if (ok) setStatus(mode === 'line' ? '已打开本句精读笔记。' : '已打开整段精读笔记。');
    }
    document.getElementById('note-line-btn').addEventListener('click', () => openSceneIntensiveNote('line'));
    document.getElementById('note-scene-btn').addEventListener('click', () => openSceneIntensiveNote('scene'));
    const shadowBtn = document.getElementById('shadow-btn');
    shadowBtn.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      try { shadowBtn.setPointerCapture(event.pointerId); } catch (_) {}
      onSpeakPress();
    });
    shadowBtn.addEventListener('pointerup', onSpeakRelease);
    shadowBtn.addEventListener('pointercancel', onSpeakRelease);
    document.getElementById('mic-btn').addEventListener('click', toggleMic);
    document.getElementById('reveal-btn').addEventListener('click', revealCurrent);
    document.getElementById('review-btn').addEventListener('click', reviewThree);
    document.getElementById('prev-btn').addEventListener('click', prevLine);
    document.getElementById('next-btn').addEventListener('click', nextLine);

    function shortcutTarget(el) {
      if (!el || el.disabled || el.hidden) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
      el.click();
      return true;
    }

    function isTypingTarget(el) {
      if (!el) return false;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      return Boolean(el.isContentEditable);
    }

    function readAuthToken() {
      return window.AuthManager ? window.AuthManager.getToken() || '' : '';
    }

    function englishEnough(line) {
      const words = String(line || '').match(/[A-Za-z][A-Za-z']*/g) || [];
      return words.join('').length >= 6;
    }

    function paperBlocks(content) {
      try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.kind === 'exam-paper' && Array.isArray(parsed.blocks)) return parsed;
      } catch (_) {}
      return null;
    }

    function isLongText(text) {
      const raw = String(text || '').trim();
      const words = raw.match(/[A-Za-z][A-Za-z']*/g) || [];
      const sentences = raw.split(/[.!?。！？]/).filter((item) => item.trim().length > 6);
      return words.length > 22 || sentences.length > 1 || raw.length > 120;
    }

    function makeTurn(who, text, extra) {
      const turn = [who, text, ''];
      Object.assign(turn, extra || {});
      return turn;
    }

    function collectAnswers(blocks) {
      const map = new Map();
      (blocks || []).forEach((block) => {
        if (block.type !== 'answer') return;
        (block.lines || []).forEach((line) => {
          const text = String(line.text || '').trim();
          const spoken = String(line.speak || '');
          const range = text.match(/(\d+)\s*[-–~到至]\s*(\d+)\s*([A-Ea-e]+)\b/)
            || spoken.match(/第(\d+)到第(\d+)题的答案是\s*([A-E，,\s]+)/);
          if (range) {
            const from = Number(range[1]);
            const to = Number(range[2]);
            const letters = /[，,]/.test(range[3])
              ? range[3].split(/[，,\s]+/).filter(Boolean)
              : range[3].toUpperCase().split('');
            letters.forEach((letter, offset) => {
              const number = from + offset;
              if (number <= to && /^[A-E]$/i.test(letter)) map.set(number, letter.toUpperCase());
            });
            return;
          }
          const single = text.match(/^(\d{1,3})[.、．]\s*(.+)$/)
            || spoken.match(/第(\d+)题的答案是\s*(.+)$/)
            || spoken.match(/第(\d+)题，\s*(.+)$/);
          if (single) map.set(Number(single[1]), single[2].trim());
        });
      });
      return map;
    }

    function scenesFromPaper(paper, title) {
      const answers = collectAnswers(paper.blocks);
      const scenes = [];
      let current = null;
      let group = '';
      const push = () => {
        if (current && current.turns.length) {
          const passages = current.turns.filter((turn) => turn.kind === 'passage' && turn[0] === '课文');
          if (passages.length > 1) passages.forEach((turn, index) => { turn[0] = `课文 ${index + 1}`; });
          const keys = current.turns.filter((turn) => turn.kind === 'answer');
          if (keys.length > 1) keys.forEach((turn, index) => { turn[0] = `答案 ${index + 1}`; });
          scenes.push(current);
        }
        current = null;
        group = '';
      };
      const ensure = () => {
        if (!current) current = { tag: '教材', title: paper.title || title, place: title, turns: [] };
      };
      (paper.blocks || []).forEach((block) => {
        if (block.type === 'heading' && block.level === 2) {
          push();
          current = { tag: '教材', title: block.text, place: title, turns: [] };
          return;
        }
        if (block.type === 'heading' && block.level === 3) {
          ensure();
          group = block.text;
          return;
        }
        if (block.type === 'choices') {
          const prev = current && current.turns[current.turns.length - 1];
          if (prev && prev.kind === 'question' && !(prev.options || []).length) {
            prev.options = (block.items || []).map((item) => String(item).trim()).filter(Boolean);
            prev.speak = [prev.stem, ...prev.options].filter(Boolean).join(' ');
          }
          return;
        }
        if (block.type === 'question') {
          ensure();
          const number = Number(block.number);
          const stem = String(block.stem || '').trim();
          const options = (block.options || []).map((item) => String(item).trim()).filter(Boolean);
          const speak = [stem, ...options].filter(Boolean).join(' ') || String(block.speak || '');
          if (!englishEnough(speak) && !/[\u4e00-\u9fff]{4,}/.test(speak)) return;
          current.turns.push(makeTurn(number ? `第${number}题` : '题目', stem || speak, {
            kind: 'question',
            stem,
            options,
            answer: answers.get(number) || '',
            speak,
            group,
            long: isLongText(stem),
          }));
          return;
        }
        if (block.type === 'passage') {
          ensure();
          const paragraphs = (block.paragraphs || []).map((item) => String(item.text || item.speak || '').trim()).filter(Boolean);
          if (!paragraphs.length) return;
          const body = paragraphs.join('\n\n');
          current.turns.push(makeTurn('课文', body, {
            kind: 'passage',
            body,
            speak: body,
            group,
            long: true,
          }));
          return;
        }
        if (block.type === 'answer') {
          ensure();
          (block.lines || []).forEach((line) => {
            const text = String(line.text || '').trim();
            if (!text) return;
            const spoken = line.speak || text;
            current.turns.push(makeTurn('答案', spoken, {
              kind: 'answer',
              body: text,
              speak: spoken,
              answer: text,
              group,
              long: isLongText(text),
            }));
          });
          return;
        }
        if ((block.type === 'prompt' || block.type === 'info' || block.type === 'note' || block.type === 'list') && (block.text || block.items)) {
          const text = String(block.text || (block.items || []).join('\n')).trim();
          if (!text) return;
          if (!englishEnough(text) && !/[\u4e00-\u9fff]{6,}/.test(text)) return;
          ensure();
          const long = isLongText(text);
          current.turns.push(makeTurn('说明', text, {
            kind: long ? 'passage' : 'note',
            body: text,
            speak: text,
            group,
            long,
          }));
        }
      });
      push();
      return scenes;
    }

    function scenesFromPlain(content, title) {
      const raw = String(content || '').replace(/\r/g, '').trim();
      if (!raw) return [];
      const chunks = raw.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
      const units = chunks.length > 1 ? chunks : raw.split(/\n/).map((item) => item.trim()).filter(Boolean);
      const heading = (line) => {
        const one = line.split('\n')[0].trim();
        if (line.includes('\n') || one.length > 36) return false;
        return /^第[一二三四五六七八九十0-9]+[部节章课]/.test(one)
          || /^(unit|chapter|lesson)\b/i.test(one)
          || /^#{1,3}\s+\S/.test(one);
      };
      const scenes = [];
      let current = null;
      let paragraph = 0;
      const push = () => {
        if (current && current.turns.length) scenes.push(current);
        current = null;
        paragraph = 0;
      };
      units.forEach((unit) => {
        if (heading(unit)) {
          push();
          current = { tag: '教材', title: unit.replace(/^#{1,3}\s+/, '').trim(), place: title, turns: [] };
          return;
        }
        const text = unit.trim();
        if (!englishEnough(text) && !/[\u4e00-\u9fff]{6,}/.test(text)) return;
        if (!current) current = { tag: '教材', title, place: '导入的课文', turns: [] };
        paragraph += 1;
        const long = isLongText(text);
        current.turns.push(makeTurn(long ? `第${paragraph}段` : `第${paragraph}句`, text, {
          kind: long ? 'passage' : 'text',
          body: text,
          speak: text,
          long,
        }));
      });
      push();
      return scenes;
    }

    function scenesFromArticle(article) {
      const title = String(article.title || '我的教材');
      const paper = paperBlocks(article.content);
      if (paper) return scenesFromPaper(paper, title);
      return scenesFromPlain(article.content, title);
    }

    async function openMaterial(id) {
      if (recording) {
        setStatus('先结束跟读，再打开教材。');
        return;
      }
      const token = readAuthToken();
      closeMaterialsModal();
      setStatus('正在打开教材…');
      try {
        const response = await fetch('/articles/' + encodeURIComponent(id), {
          headers: token ? { Authorization: 'Bearer ' + token } : {},
        });
        const article = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(article.message || '打不开这份教材');
        const scenes = scenesFromArticle(article);
        if (!scenes.length) {
          setStatus('这份教材里没有可跟读的句子。');
          return;
        }
        releasePlayback();
        materialScenes = scenes;
        packId = 'material';
        sceneIndex = 0;
        lineIndex = 0;
        document.querySelectorAll('.pack').forEach((el) => el.classList.remove('active'));
        const field = document.querySelector('[data-pack="field"]');
        if (field) field.classList.remove('active');
        document.getElementById('review').hidden = true;
        stopSpeech();
        render();
        document.getElementById('scenes').scrollTop = 0;
        const total = scenes.reduce((sum, item) => sum + item.turns.length, 0);
        setStatus(`已打开「${article.title || '教材'}」。${scenes.length} 个章节，${total} 项。左侧按章节选题。短题看选项，长文点开阅读。`);
        const next = './daily-speaking.html?material=' + encodeURIComponent(id);
        if (location.pathname.endsWith('daily-speaking.html') && location.search !== '?material=' + encodeURIComponent(id)) {
          history.replaceState(null, '', next);
        }
      } catch (err) {
        setStatus(err.message || '教材没有打开。');
      }
    }

    function closeMaterialsModal() {
      const modal = document.getElementById('materials-modal');
      if (!modal || modal.hidden) return;
      modal.hidden = true;
    }

    async function openMaterialsModal() {
      const modal = document.getElementById('materials-modal');
      const list = document.getElementById('materials-list');
      if (!modal || !list) return;
      modal.hidden = false;
      list.innerHTML = '<p class="hint">正在读取…</p>';
      const token = readAuthToken();
      if (!token) {
        list.innerHTML = '<p class="hint">登录后才能查看已导入的教材。也可以先去导入页。</p>';
        return;
      }
      try {
        const response = await fetch('/articles', { headers: { Authorization: 'Bearer ' + token } });
        const data = await response.json().catch(() => ({}));
        const kinds = new Set(['pdf', 'text', 'txt', 'md', 'docx', 'epub', 'image', 'html']);
        const items = (data.items || []).filter((article) =>
          kinds.has(article.source_type) || article.pdf_path
        );
        if (!items.length) {
          list.innerHTML = '<p class="hint">还没有导入的教材。点下方「导入新教材」添加。</p>';
          return;
        }
        list.innerHTML = items.map((article) => {
          const kind = article.source_type || '文档';
          return `<button class="materials-item" type="button" data-material="${escapeHtml(article.id)}">
            <span>
              <strong>${escapeHtml(article.title || '未命名文档')}</strong>
              <em>${escapeHtml(kind)} · ${article.word_count || 0} 词</em>
            </span>
            <span class="enter">在这页练</span>
          </button>`;
        }).join('');
      } catch (_) {
        list.innerHTML = '<p class="hint">暂时读不到教材列表，请稍后再试。</p>';
      }
    }

    document.getElementById('materials-list').addEventListener('click', (event) => {
      const item = event.target.closest('[data-material]');
      if (!item) return;
      openMaterial(item.dataset.material);
    });
    document.getElementById('materials-btn').addEventListener('click', openMaterialsModal);
    document.getElementById('materials-close').addEventListener('click', closeMaterialsModal);
    document.getElementById('materials-modal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeMaterialsModal();
    });

    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTypingTarget(event.target)) return;

      const materialsOpen = !document.getElementById('materials-modal').hidden;
      if (materialsOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeMaterialsModal();
        }
        return;
      }

      const key = event.key;
      if (key === ' ' || key === 'Spacebar') {
        event.preventDefault();
        if (recording) {
          shortcutTarget(document.getElementById('mic-btn'));
          return;
        }
        shortcutTarget(document.getElementById('play-btn'));
        return;
      }
      if (key === 'ArrowLeft') {
        event.preventDefault();
        shortcutTarget(document.getElementById('prev-btn'));
        return;
      }
      if (key === 'ArrowRight') {
        event.preventDefault();
        shortcutTarget(document.getElementById('next-btn'));
        return;
      }
      if (key === 'Enter') {
        event.preventDefault();
        if (event.repeat || enterHeld) return;
        enterHeld = true;
        onSpeakPress();
        return;
      }
      if (key === 'm' || key === 'M') {
        event.preventDefault();
        shortcutTarget(document.getElementById('mic-btn'));
      }
    });
    function clearLineAudio() {
      const audio = document.getElementById('line-audio');
      const playing = audio && audio.src && !audio.paused && !audio.ended;
      if (playing) haltPlayback();
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      const row = document.getElementById('line-audio-row');
      if (row) row.hidden = true;
      setStatus('已删除这句原声。再点「播放」会重新读。');
    }

    function clearMineAudio() {
      const mine = document.getElementById('mine-audio');
      if (mine) {
        mine.pause();
        mine.removeAttribute('src');
        mine.load();
      }
      if (mineUrl) URL.revokeObjectURL(mineUrl);
      mineUrl = '';
      const row = document.getElementById('mine-audio-row');
      if (row) row.hidden = true;
      document.getElementById('mine-btn').disabled = true;
      setStatus('已删除你的跟读。');
    }

    document.getElementById('line-audio-delete').addEventListener('click', () => {
      if (recording) {
        setStatus('正在录音。先结束跟读，再删除原声。');
        return;
      }
      clearLineAudio();
    });
    document.getElementById('mine-audio-delete').addEventListener('click', () => {
      if (recording) {
        setStatus('正在录音。先结束跟读，再删除跟读。');
        return;
      }
      clearMineAudio();
    });

    document.addEventListener('keyup', (event) => {
      if (event.key !== 'Enter' || !enterHeld) return;
      enterHeld = false;
      onSpeakRelease();
    });
    window.addEventListener('blur', () => {
      enterHeld = false;
      if (speakHold) onSpeakRelease();
    });
    document.getElementById('mine-btn').addEventListener('click', () => {
      const mine = document.getElementById('mine-audio');
      if (!mine.src) return;
      mine.play().catch(() => {});
      setStatus('正在播放你的跟读。');
    });

    document.getElementById('accent').addEventListener('click', (event) => {
      const button = event.target.closest('[data-accent]');
      if (!button) return;
      const next = button.dataset.accent;
      if (next !== 'us' && next !== 'uk') return;
      if (next === accentId) return;
      if (recording) {
        setStatus('正在录音。先结束跟读，再切换美式或英式。');
        return;
      }
      haltPlayback();
      const previousTitle = scene() ? scene().title : '';
      accentId = next;
      try { localStorage.setItem('linglish_daily_accent', accentId); } catch (_) {}
      applyAccentVoice();
      document.querySelectorAll('[data-accent]').forEach((el) => {
        el.classList.toggle('active', el.dataset.accent === accentId);
      });
      if (packId !== 'core') {
        const target = pairTitle(previousTitle);
        const found = activeScenes().findIndex((item) => item.title === target);
        sceneIndex = found >= 0 ? found : Math.min(sceneIndex, Math.max(activeScenes().length - 1, 0));
        lineIndex = 0;
        document.getElementById('review').hidden = true;
      }
      render();
      const active = document.querySelector('#scenes .line.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
      const voiceName = window.LinglishTtsVoice ? LinglishTtsVoice.meta().name : '';
      setStatus(accentId === 'uk'
        ? `已切到英式${voiceName ? '，' + voiceName + ' 来读' : ''}。鞋服按英国门店来说。`
        : `已切到美式${voiceName ? '，' + voiceName + ' 来读' : ''}。鞋服按美国门店来说。`);
    });

    document.querySelectorAll('[data-accent]').forEach((el) => {
      el.classList.toggle('active', el.dataset.accent === accentId);
    });
    applyAccentVoice();
    waitForVoices();
    loadGlossLexicon();
    render();
    const materialId = new URLSearchParams(location.search).get('material');
    if (materialId) openMaterial(materialId);
  

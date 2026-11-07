// What the plush world says to you at every kilometre, in English and Japanese
export interface Cheer {
  emoji: string
  en: string
  ja: string
}

export const CHEERS: Cheer[] = [
  { emoji: '🧸', en: 'The bears are cheering for you!', ja: 'くまさんたちが応援してるよ！' },
  { emoji: '🌈', en: 'You pedal, the rainbow sparkles!', ja: 'こぐたびに虹がキラキラ！' },
  { emoji: '🍄', en: 'The mushrooms say: so fast!', ja: 'キノコさんも「はやーい！」って' },
  { emoji: '☁️', en: 'Fluffy legs, fluffy heart!', ja: 'あしもこころもふわっふわ！' },
  { emoji: '🎀', en: 'A ribbon for your hard work!', ja: 'がんばったあなたにリボンをどうぞ！' },
  { emoji: '🧁', en: 'One more kilometre, one more cupcake!', ja: 'あと1キロごとにカップケーキ1こ！' },
  { emoji: '🐻', en: 'Big bear hug incoming!', ja: 'くまさんのぎゅーっが届くよ！' },
  { emoji: '✨', en: 'Your wheels are made of stardust!', ja: 'タイヤが星くずでできてるみたい！' },
  { emoji: '🍭', en: 'Sweet ride! Keep rolling!', ja: 'あまーい走り！そのままコロコロ！' },
  { emoji: '🌸', en: 'The flowers turned to watch you!', ja: 'お花たちがふりむいて見てるよ！' },
  { emoji: '🧶', en: 'Stitch by stitch, you got this!', ja: 'ひと針ずつ、ちゃんと進んでる！' },
  { emoji: '🎈', en: 'Light as a balloon today!', ja: '今日は風船みたいにかるいね！' },
  { emoji: '🐰', en: 'Hop hop! Even the bunnies are impressed!', ja: 'ぴょんぴょん！うさぎさんもびっくり！' },
  { emoji: '💖', en: 'Every pedal stroke is a little heart!', ja: 'ひとこぎごとに、ちいさなハート！' },
  { emoji: '🍓', en: 'Strawberry power, full charge!', ja: 'いちごパワー、満タンだよ！' },
  { emoji: '🌟', en: 'Shining brighter every kilometre!', ja: '1キロごとにピカピカ度アップ！' },
  { emoji: '🦄', en: 'A unicorn would be jealous!', ja: 'ユニコーンもうらやましがってる！' },
  { emoji: '🍩', en: 'Round and round, like a donut!', ja: 'ドーナツみたいにくるくる一周！' },
  { emoji: '🐥', en: 'Peep peep! Great job!', ja: 'ぴよぴよ！じょうずだね！' },
  { emoji: '🎠', en: 'Whee! Best ride in Plushland!', ja: 'わーい！ぬいぐるみの国でいちばん！' },
  { emoji: '🫧', en: 'Bubbly legs, happy wheels!', ja: 'あしはシュワシュワ、タイヤはごきげん！' },
  { emoji: '🍪', en: 'You earned a cookie. Or two!', ja: 'クッキーもらえるよ。2まいでも！' },
  { emoji: '🌷', en: 'The road is smiling at you!', ja: '道もにっこりしてるよ！' },
  { emoji: '🐼', en: 'Panda says: you are amazing!', ja: 'パンダさん「すごすぎる〜！」' },
  { emoji: '🎵', en: 'Your pedals are humming a song!', ja: 'ペダルが鼻歌うたってるね！' },
  { emoji: '🧃', en: 'Sip, smile, and keep spinning!', ja: 'ひとくち飲んで、にっこり、くるくる！' },
  { emoji: '🌙', en: 'Even the moon wants to ride with you!', ja: 'お月さまもいっしょに走りたいって！' },
  { emoji: '🍬', en: 'Candy-coated kilometre, done!', ja: 'あまあま1キロ、クリア！' },
  { emoji: '🐱', en: 'Purr-fect pedalling!', ja: 'にゃんともすてきなペダリング！' },
  { emoji: '🎉', en: 'Party time! Another kilometre!', ja: 'パーティーだ！また1キロ！' },
]

/** A shuffled deck: no message comes round again until all the others have */
export function cheerDeck() {
  let deck: Cheer[] = []
  return () => {
    if (!deck.length) {
      deck = [...CHEERS]
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[deck[i], deck[j]] = [deck[j]!, deck[i]!]
      }
    }
    return deck.pop()!
  }
}

// Japanese / English. The Japanese text in the code is the key: t('撃破！') gives the English
// line when English is on, otherwise the key itself. {name} placeholders are filled from vars.
// Static text in index.html is translated by scanning its text nodes and a few attributes once.

const EN = {
  // ---------------------------------------------------------------- index.html (static)
  '招待': 'Invite', 'サウンドのオン・オフ': 'Sound on / off', '設定': 'Settings',
  'WASD 移動 ／ マウス 照準 ／ 左クリック 射撃 ／ Space ジャンプ ／ Shift・右クリック ドリフト（溜めて離すと加速） ／ E サイドアーム ／ Q 必殺技 ／ Esc マウス解放':
    'WASD move / Mouse aim / Left click fire / Space jump / Shift or right click drift (hold, release to boost) / E sidearm / Q special / Esc free mouse',
  'タップして名前を変える': 'Tap to change your name', '名前': 'Name', '別の端末とデータを引き継ぐ': 'Move your data to another device', '引き継ぎ': 'Transfer',
  'メニュー': 'Menu', 'ガレージ': 'Garage', 'ミッション': 'Missions', '装備（タップで変更）': 'Loadout (tap to change)',
  'サイドアームを変える': 'Change sidearm', '必殺技を変える': 'Change special', 'この部屋に参加': 'Join this room',
  'クイックマッチの条件を変える': 'Change quick match options', '変更': 'Change', '合言葉': 'Passphrase', 'クイックマッチ': 'Quick Match',
  'オフラインです。対戦にはインターネット接続が必要です。': 'You are offline. Battles need an internet connection.',
  'ホーム画面に追加': 'Add to Home Screen', 'クレジット': 'Credits', '閉じる': 'Close',
  'クイックマッチの条件': 'Quick match options', 'モード': 'Mode', 'どちらでも': 'Any', '個人戦': 'Free-for-all', 'チーム戦': 'Team battle',
  '人数': 'Players', '2人': '2', '3人': '3', '4人': '4', '勝利条件': 'Win by', '5分間で多く倒す': 'Most kills in 5 min', '先に': 'First to',
  'キル数': 'Kills', 'キル': 'kills', '同じ条件を選んだ人どうしで対戦します。': 'You are matched with players who chose the same options.',
  '決定': 'Done', '合言葉で遊ぶ': 'Play with a passphrase', '友達と同じ合言葉を入れると、同じ部屋に入れます。': 'Type the same passphrase as your friends to end up in the same room.',
  '合言葉（例：たこやき）': 'Passphrase (e.g. tacos)', '合言葉をおまかせで決める': 'Pick a random passphrase', 'おまかせ': 'Random',
  'ルールは最初に入った人のものになります。よくある言葉だと、知らない人と同じ部屋になることがあります。': 'The first person in sets the rules. Common words may put you in a room with strangers.',
  '合言葉で入る': 'Enter with passphrase', '装備': 'Loadout', 'デイリー': 'Daily', '長期（称号）': 'Long-term (titles)', 'レベル報酬': 'Level rewards',
  'データ引き継ぎ': 'Data transfer',
  'レベル・アイテム・ミッションの進み具合は、この端末に保存されたIDでサーバーに記録されています（アカウント登録は不要）。機種変更するときや、iPhoneでSafariとホーム画面版の両方で遊ぶときは、引き継ぎコードで同じデータを使えます。':
    'Your level, items and missions are saved on the server under an ID kept on this device (no sign-up). When you change phones, or play both in Safari and the home-screen app on an iPhone, a transfer code lets you use the same data.',
  'この端末のデータを別の端末で使う': 'Use this device\'s data on another device', '引き継ぎコードを発行': 'Get a transfer code',
  '別の端末のデータをこの端末で使う': 'Use another device\'s data here', '引き継ぐ': 'Transfer',
  '友達にこの合言葉を伝えて、ロビーの「合言葉」に同じ言葉を入れてもらうと、この部屋で一緒に遊べます（最大4人）。': 'Tell your friends this passphrase. When they enter it under "Passphrase" in the lobby, they join this room (up to 4 players).',
  'このURLを送ると同じ部屋に参加できます（最大4人）。': 'Send this URL to invite friends to this room (up to 4 players).',
  'コピー': 'Copy', '共有': 'Share', '画質': 'Quality', '低': 'Low', '中': 'Mid', '高': 'High', '感度': 'Sensitivity', '効果音': 'Sound effects', '装備を変える': 'Change loadout',
  'クイックマッチの部屋はルール固定です（同じモード・人数・勝利条件を選んだ人どうしで集めるため）。ルールはロビーで選べます。': 'Quick match rooms have fixed rules (players are grouped by mode, size and win condition). Choose them in the lobby.',
  'このルールでニューゲーム': 'New game with these rules', 'チームを変える': 'Switch team',
  'ニューゲームは全員のスコアと試合をリセットして最初からやり直します（2回押し）。': 'New game resets everyone\'s score and restarts the match (press twice).',
  '全画面': 'Fullscreen', '退出': 'Leave', '試合終了': 'Match over', 'すぐに次の試合へ': 'Next match now', '端末を横向きにしてください': 'Please turn your device sideways', '読み込み中…': 'Loading…',
  '招待URL': 'Invite URL', 'ガレージ ': 'Garage ', 'Language': 'Language',

  // ---------------------------------------------------------------- lobby / room (dynamic)
  '初期化に失敗しました: {m}': 'Could not start: {m}', '部屋 {id} に参加': 'Join room {id}', '合言葉は2〜16文字にしてください。': 'Passphrases are 2 to 16 characters.',
  'チーム戦（2対2）': 'Team battle (2 v 2)', '{n}人': '{n} players', '{n}キル先取': 'First to {n} kills', '5分間': '5 min',
  'この部屋：クイックマッチ・{r}': 'This room: Quick match · {r}', 'この部屋のルール：{r}（{n}/4人）': 'Room rules: {r} ({n}/4 players)',
  '撃破！': 'Destroyed!', 'ニューゲーム': 'New game', 'コピーしました': 'Copied',
  'Hover Tank Arenaで一緒に対戦しよう！ ロビーの「合言葉」に「{p}」と入れてね': 'Battle with me in Hover Tank Arena! Enter "{p}" under "Passphrase" in the lobby.',
  '一緒に対戦しよう': 'Come battle with me', 'もう一度押すとリセット': 'Press again to reset',
  'サイドアームを選ぶ': 'Choose a sidearm', '必殺技を選ぶ': 'Choose a special', 'サーバーに接続中…': 'Connecting…',
  '別の部屋を探しています…': 'Trying another room…', '対戦相手を探しています…': 'Finding opponents…',
  'この部屋は満室です（最大4人）。': 'This room is full (max 4 players).', '部屋が見つかりません。URLが違うか、部屋が削除された可能性があります。': 'Room not found. The link may be wrong or the room was closed.',
  '接続できませんでした: {m}': 'Could not connect: {m}', '合言葉「{p}」の部屋を作りました': 'Created the room for passphrase "{p}"',
  '合言葉「{p}」の部屋に参加しました（{r}）': 'Joined the room for passphrase "{p}" ({r})', 'クイックマッチ：対戦に参加しました': 'Quick match: you joined a battle',
  'クリックで操作開始': 'Click to start', '接続が切れました。再接続中…': 'Connection lost. Reconnecting…', 'もう一度参加': 'Join again',
  'サーバーとの接続が切れました（{s}秒以内の再接続に失敗）。': 'Lost the connection to the server (could not reconnect within {s} s).',
  '{n} が{t}に移動': '{n} moved to {t}', '{n} がニューゲームを開始しました（{r}）': '{n} started a new game ({r})',
  '中央の丘に回復アイテムが出現！': 'A repair kit appeared on the centre hill!', '全回復！': 'Fully repaired!', 'マッチング中': 'Matching',
  '✚ 回復アイテム 出現中（中央の丘）': '✚ Repair kit is up (centre hill)', '✚ 回復まで {n}秒': '✚ Repair kit in {n}s', '✚ 回復': '✚ Repair',
  '{n} が回復した': '{n} got repaired', '撃破された…': 'You were destroyed…', '{n} の必殺技　{s}': '{n} used a special: {s}',
  'はね返された！': 'Reflected back!', 'ジャストガード！': 'Perfect guard!', '（味方）': ' (your team)', 'クイックマッチ・{r}': 'Quick match · {r}',
  'CPU{n}（{l}）': 'CPU ×{n} ({l})', 'CPU': 'CPU', 'CPUの強さ': 'CPU level', 'なし': 'None', '{n}体': '{n}',
  'よわい': 'Easy', 'ふつう': 'Normal', 'つよい': 'Hard',
  '引き分け': 'Draw', '{t}の勝利！': '{t} wins!', '{n} の勝利！': '{n} wins!', '（あなたの勝ち）': '(you won)',
  '{k} 撃破 / {d} 被撃破': '{k} kills / {d} deaths', ' (切断中)': ' (disconnected)', '10秒後に次の試合が始まります': 'The next match starts in 10 seconds',
  '無敵 {s}秒（撃つと解除）': 'Shielded {s}s (firing ends it)', '対戦相手を探しています… {n}\n（そのあいだ自由に走れます）': 'Finding opponents… {n}\n(drive around freely meanwhile)',
  'リスポーンまで {s} 秒': 'Respawn in {s}s', '必殺技 {s} READY（{k}）': 'Special {s} READY ({k})', 'SPボタン': 'SP button', 'Qキー': 'Q key',
  '{n}秒': '{n}s', 'サイドアーム': 'Sidearm', '必殺技': 'Special', '（{k}・クールダウン制）': '({k}, cooldown)', '（{k}・ゲージ満タンで使える）': '({k}, when the meter is full)',
  'SUBボタン': 'SUB button', 'Eキー': 'E key', '（クールダウン{n}秒）': ' (cooldown {n}s)', 'コツ：{t}': 'Tip: {t}',
  '赤チーム': 'Red team', '青チーム': 'Blue team', '{a}・{b}': '{a} · {b}',

  // ---------------------------------------------------------------- after a match
  '次の試合': 'Next match', '装備を変える': 'Change loadout', 'ルール変更': 'Change rules', 'ロビーへ戻る': 'Back to lobby', 'このルールにする': 'Use these rules', 'やめる': 'Cancel',
  '次の試合へ': 'Ready', '結果': 'Results', '「次の試合」ですぐに次の対戦相手を探します': '"Next match" finds new opponents right away',
  '準備OK {a}/{b}　全員そろうと次の試合が始まります': 'Ready {a}/{b} · the next match starts when everyone is ready', '（{n} を待っています）': ' (waiting for {n})',
  '自由砲撃タイム　準備OK {a}/{b}（全員そろうと次の試合）': 'Free fire · ready {a}/{b} (next match when everyone is ready)', '次の試合の準備 {a}/{b}': 'Next match: ready {a}/{b}',
  '準備OK！ほかの人を待つあいだ自由に撃てます': 'Ready! Shoot freely while the others get ready', '{n} が準備OK': '{n} is ready',
  '{n} が次の試合のルールを変更しました（{r}）': '{n} changed the rules for the next match ({r})', '次の試合スタート！': 'Next match — go!', '自由砲撃': 'Free fire',

  // ---------------------------------------------------------------- net.js
  '部屋を作れませんでした ({s})': 'Could not create a room ({s})', 'この合言葉の部屋は満室です': 'The room for this passphrase is full',
  '合言葉は2〜16文字にしてください': 'Passphrases are 2 to 16 characters', '部屋に入れませんでした ({s})': 'Could not enter the room ({s})',
  'マッチングに失敗しました ({s})': 'Matchmaking failed ({s})', 'サーバーエラー ({s})': 'Server error ({s})', '接続がタイムアウトしました': 'Connection timed out',
  '接続できませんでした ({s})': 'Could not connect ({s})',
  'Safariの共有ボタン（□↑）→「ホーム画面に追加」で、アプリのように全画面で起動できます。': 'In Safari, tap Share (□↑) → "Add to Home Screen" to launch it full screen like an app.',

  // ---------------------------------------------------------------- progress UI
  'Lv.{n}で解放': 'Unlocks at Lv.{n}', '「{t}」（{x}）で解放': 'Unlocked by "{t}" ({x})', '{n} XP（最大レベル）': '{n} XP (max level)', '保存済み': 'Saved',
  '解放済み {a} / {b}': 'Unlocked {a} / {b}', '自分の戦車がプレビューされます（決定すると他のプレイヤーにも反映）': 'Previewing your tank (press Done to show it to other players too)',
  '保存しました': 'Saved', '保存できませんでした（{m}）': 'Could not save ({m})',
  '毎日0時（日本時間）に更新・あと{h}時間{m}分 ／ 1日1回だけミッションを入れ替えられます': 'New missions every day at 0:00 JST · {h}h {m}m left / you can swap one mission a day',
  'かんたん': 'Easy', 'むずかしい': 'Hard', '達成！': 'Done!', '入れ替え': 'Swap', '3つ全部達成でボーナス': 'Bonus for finishing all three',
  '達成すると称号（ガレージの「称号」で付けられます）と経験値がもらえます。達成 {a} / {b}': 'Each one gives a title (wear it from Garage → Title) and XP. Done {a} / {b}',
  '称号「{t}」': 'Title "{t}"', '5レベルごとに小さな報酬、10レベルごとに大きな報酬。強さは変わりません（見た目だけ）。': 'A small reward every 5 levels and a big one every 10. Looks only: nothing makes you stronger.',
  '大報酬': 'Big reward', '小報酬': 'Small reward',
  '{d} まで有効・1回だけ使えます。この画面を他の人に見せないでください。': 'Valid until {d}, one use only. Do not show this screen to anyone.',
  '発行できませんでした（{m}）': 'Could not get a code ({m})',
  'この端末の今のデータは、入力したコードのデータに置き換わります。もう一度押すと引き継ぎます。': 'This device\'s current data will be replaced by the data of that code. Press again to transfer.',
  '引き継ぎました（Lv.{n}）': 'Transferred (Lv.{n})', '試行回数が多すぎます。しばらく待ってからやり直してください。': 'Too many tries. Please wait a while and try again.',
  'コードが違うか、期限が切れています。': 'Wrong or expired code.', 'この試合は経験値の対象外でした（ほとんど動いていないため）': 'No XP for this match (you hardly moved)',
  'レベルアップ！ Lv.{a} → {b}': 'Level up! Lv.{a} → {b}', '新しく解放：': 'New unlocks: ', 'ロビーまたは⚙のガレージで装備できます': 'Equip them from the Garage (lobby or ⚙)',
  // match XP lines (sent by the server in Japanese)
  '参加（基礎）': 'Took part', '撃破 ×{n}': 'Kills ×{n}', '命中 ×{n}': 'Hits ×{n}', '勝利': 'Win', '2位': '2nd place', 'ドリフトターボ': 'Drift turbo',
  '回復アイテム': 'Repair kits', '本日初プレイ': 'First match today', '本日初勝利': 'First win today', 'デイリー：{t}': 'Daily: {t}',
  'デイリー全達成ボーナス': 'All dailies bonus', '称号「{t}」獲得': 'Title "{t}" earned',

  // ---------------------------------------------------------------- items (shared/progress.js)
  '塗装': 'Paint', '柄': 'Pattern', '砲塔': 'Turret', 'リアパーツ': 'Rear part', 'サイド／フロント': 'Side / front', 'ホバーの光': 'Hover glow',
  '弾の軌跡': 'Shell trail', 'ドリフト火花': 'Drift sparks', '撃破演出': 'Kill effect', 'エンブレム': 'Emblem', '名札の枠': 'Name frame', '称号': 'Title',
  '席の色（自動）': 'Seat colour (auto)', 'レッド': 'Red', 'ブルー': 'Blue', 'イエロー': 'Yellow', 'グリーン': 'Green', 'オレンジ': 'Orange', 'シアン': 'Cyan',
  'サンド': 'Sand', 'オリーブ': 'Olive', 'ネイビー': 'Navy', 'パールホワイト': 'Pearl white', 'マットブラック': 'Matte black', 'ゴールド': 'Gold', 'クリムゾン': 'Crimson', 'サクラ': 'Sakura',
  'レーシングストライプ': 'Racing stripes', '砂漠迷彩': 'Desert camo', 'タイガー': 'Tiger', 'デジタル迷彩': 'Digital camo', 'ファイヤー': 'Flames', 'カーボン': 'Carbon',
  'チェッカー': 'Checker', 'ハザード': 'Hazard',
  '標準砲塔': 'Standard turret', 'ツインバレル': 'Twin barrel', 'ロングバレル': 'Long barrel', 'ヘビーキャノン': 'Heavy cannon', 'レールガン': 'Railgun',
  'キングス砲塔': 'King\'s turret', 'ドーム砲塔': 'Dome turret', 'ミサイルポッド': 'Missile pods',
  'リアスポイラー': 'Rear spoiler', 'ツインフィン': 'Twin fins', 'ジェットウイング': 'Jet wings', 'フラッグアンテナ': 'Flag antenna', 'ツインマフラー': 'Twin exhausts',
  'サイドスカート': 'Side skirts', 'フロントブレード': 'Front blade', 'サイドポッド': 'Side pods', 'カナード': 'Canards',
  'シアン（標準）': 'Cyan (standard)', 'マゼンタ': 'Magenta', 'エメラルド': 'Emerald',
  '標準（黄）': 'Standard (yellow)', 'アイス': 'Ice', 'ネオングリーン': 'Neon green', 'バイオレット': 'Violet', 'ローズ': 'Rose',
  '標準（白）': 'Standard (white)', 'ピンク': 'Pink', 'レインボー': 'Rainbow',
  '爆炎（標準）': 'Fireball (standard)', 'プラズマ': 'Plasma', '花火': 'Fireworks', '紙吹雪': 'Confetti', '黒炎': 'Black flame',
  'スター': 'Star', 'イナズマ': 'Bolt', 'ドクロ': 'Skull', 'ウイング': 'Wings', 'クラウン': 'Crown', 'ハート': 'Heart', '照準': 'Crosshair', 'クローバー': 'Clover',
  'ブロンズ': 'Bronze', 'シルバー': 'Silver', 'プラチナ': 'Platinum',
  '一人前': 'Rookie No More', 'ベテラン': 'Veteran', 'エース': 'Ace', 'ホバーマスター': 'Hover Master',
  // daily missions
  '試合を2回プレイする': 'Play 2 matches', '合計3機撃破する': 'Destroy 3 tanks', 'ドリフトターボを5回出す': 'Fire off 5 drift turbos', '砲弾を10発当てる': 'Land 10 hits',
  'ジャンプを15回する': 'Jump 15 times', '試合を4回プレイする': 'Play 4 matches', '合計8機撃破する': 'Destroy 8 tanks', 'オレンジのターボを5回出す': 'Fire off 5 orange turbos',
  '回復アイテムを2回取る': 'Grab 2 repair kits', '合計700ダメージを与える': 'Deal 700 damage', '1試合で3機撃破する': 'Destroy 3 tanks in one match',
  '試合に1回勝つ': 'Win a match', 'ジャンプ中に撃った弾で1機撃破する': 'Destroy a tank with a shot fired mid-jump', 'ターボ中に撃った弾で2機撃破する': 'Destroy 2 tanks with shots fired while boosting',
  '40m以上離れた敵を2機撃破する': 'Destroy 2 tanks from 40 m or more', '1試合で5機撃破する': 'Destroy 5 tanks in one match', '丘の上から3機撃破する': 'Destroy 3 tanks from the hill',
  '3キル以上・1デス以下で試合を終える': 'Finish a match with 3+ kills and at most 1 death',
  // achievements (title + condition)
  '新兵': 'Recruit', '初めての試合を終える': 'Finish your first match', '常連': 'Regular', '試合を50回プレイする': 'Play 50 matches', '古参兵': 'Old Hand', '試合を300回プレイする': 'Play 300 matches',
  'ハンター': 'Hunter', '合計100機撃破する': 'Destroy 100 tanks', '撃墜王': 'Top Gun', '合計1000機撃破する': 'Destroy 1000 tanks',
  '勝利の味': 'Taste of Victory', '試合に10回勝つ': 'Win 10 matches', '百戦錬磨': 'Battle-Hardened', '試合に100回勝つ': 'Win 100 matches',
  'ドリフト職人': 'Drift Artisan', 'ドリフトターボを300回出す': 'Fire off 300 drift turbos', 'ドリフトの神': 'Drift God', 'オレンジのターボを300回出す': 'Fire off 300 orange turbos',
  '丘の王': 'King of the Hill', '回復アイテムを50回取る': 'Grab 50 repair kits', '高みの砲手': 'High Ground', '丘の上から30機撃破する': 'Destroy 30 tanks from the hill',
  '空中戦士': 'Sky Warrior', 'ジャンプ中に撃った弾で30機撃破する': 'Destroy 30 tanks with shots fired mid-jump', '疾風': 'Gale', 'ターボ中に撃った弾で50機撃破する': 'Destroy 50 tanks with shots fired while boosting',
  'スナイパー': 'Sniper', '40m以上離れた敵を50機撃破する': 'Destroy 50 tanks from 40 m or more', '大暴れ': 'Rampage', '一騎当千': 'One-Tank Army', '1試合で10機撃破する': 'Destroy 10 tanks in one match',
  '無傷の勝者': 'Flawless', '0デス・3キル以上で試合に勝つ': 'Win a match with 3+ kills and no deaths', '破壊神': 'Destroyer', '合計30000ダメージを与える': 'Deal 30000 damage',
  'コツコツ': 'Steady', 'デイリーミッションを30個達成する': 'Finish 30 daily missions', '皆勤賞': 'Perfect Attendance', 'デイリーミッションを150個達成する': 'Finish 150 daily missions',

  // ---------------------------------------------------------------- sidearms / specials (shared/abilities.js)
  '車体の後ろに地雷を置く（30秒）。0.8秒後に作動し、敵が3m以内に入ると爆発。置けるのは1人2個まで：3個目を置くと自分の一番古い地雷がその場で爆発する。':
    'Drops a mine behind you (lasts 30 s). Arms after 0.8 s and blows up when an enemy comes within 3 m. Up to 2 mines each: laying a third sets off your oldest one where it is.',
  '速くまっすぐ飛び、壁や地面で3回まで跳ね返る砲弾。跳ねるたびに威力が上がり（30→50→70→90）、当たるとまわりにも爆風。':
    'A fast, flat shell that ricochets off walls and the ground up to 3 times. Every ricochet makes it stronger (30 → 50 → 70 → 90), and it bursts on impact.',
  '壁に当ててから当てるほど強い。遮蔽物の裏の相手を跳弾でしとめる': 'The more walls it hits first, the harder it hits. Bank it around cover to finish off hiding enemies',
  '高く跳んで急降下。跳んでいるあいだは無敵。着地点のまわり8mに衝撃波（最大55ダメージ）と吹き飛ばし。空中で使うとすぐ急降下。':
    'Leap high and dive; you are untouchable while airborne. The landing sends out an 8 m shockwave (up to 55 damage) that knocks tanks away. In the air it dives at once.',
  'ブーストダッシュ': 'Boost Dash', 'リフレクトシールド': 'Reflect Shield', '地雷': 'Mine', 'バウンド弾': 'Bounce Shell',
  'オーバードライブ': 'Overdrive', 'メガキャノン': 'Mega Cannon', 'エアストライク': 'Air Strike', 'グラウンドスラム': 'Ground Slam',
  '押した瞬間、入力している方向へ一気に加速（空中でも可）。弾をかわす・距離を詰める・ドリフトターボとつなげる。': 'A burst of speed in the direction you are steering (works in the air too). Dodge shells, close in, or chain it into a drift turbo.',
  '撃たれた瞬間に横へ。ジャンプ中に使うと空中で軌道を変えられる': 'Sidestep the moment you are shot at. Use it mid-jump to change course in the air',
  '1.5秒間、砲弾と爆風を防ぐバリア。張った直後0.25秒以内に受けた砲弾は、撃った相手へはね返す。': 'A barrier that blocks shells and blasts for 1.5 s. Shells that hit it within 0.25 s of raising it fly back at the shooter.',
  '弾が届く直前に張るとジャストガード（はね返し）': 'Raise it just before the shell lands for a perfect guard (reflect)',
  '車体の後ろに地雷を置く（最大2個・30秒）。0.8秒後に作動し、敵が3m以内に入ると爆発。': 'Drops a mine behind you (up to 2, lasts 30 s). Arms after 0.8 s and blows up when an enemy comes within 3 m.',
  '追ってくる相手の進路、回復アイテムの丘、曲がり角に': 'In the path of a chaser, on the repair hill, or around corners',
  '壁や地面で2回はね返る砲弾を、メインの砲撃とは別に撃つ。': 'Fires a shell that bounces twice off walls and the ground, on top of your main gun.',
  '壁に向けて撃って、遮蔽物の裏に隠れた相手をねらう': 'Bank it off walls to hit enemies hiding behind cover',
  '6秒間、連射が約2倍・最高速度とドリフトの溜まりが上がる。': 'For 6 s: about double fire rate, higher top speed and faster drift charge.',
  '撃ち合いの最中に。ドリフトターボと重ねると手がつけられない': 'Pop it mid-fight. With drift turbos on top, nobody can catch you',
  '速く、ほとんど落ちない大砲弾。直撃で75ダメージ、まわり5mにも爆風。': 'A fast shell that barely drops. 75 damage on a direct hit, plus a 5 m blast.',
  '遠くの相手の動きを読んで直撃させる': 'Read a distant enemy\'s movement and land the direct hit',
  '照準した場所に、1.4秒後から6発の爆撃が降る（半径5.5m）。': 'Six bombs rain down on the crosshair spot, starting 1.4 s later (5.5 m radius).',
  '相手の逃げ道や、回復アイテムを取りに来る瞬間をねらう': 'Aim for where they will run, or the moment they go for the repair kit',
  '高く跳んで急降下。着地点のまわり8mに衝撃波（最大55ダメージ）と吹き飛ばし。空中で使うとすぐ急降下。': 'Leap high and dive. The landing sends out an 8 m shockwave (up to 55 damage) that knocks tanks away. In the air it dives at once.',
  'ジャンプ中や丘の上から、敵の真ん中に落ちる': 'Drop into the middle of the enemy from a jump or from the hill',
};

const KEY = 'ht-lang';
const guess = () => { try { return (navigator.language || 'ja').toLowerCase().startsWith('ja') ? 'ja' : 'en'; } catch { return 'ja'; } };
export let lang = (() => { try { const v = localStorage.getItem(KEY); return v === 'en' || v === 'ja' ? v : guess(); } catch { return guess(); } })();

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
export function t(ja, vars) {
  return fill(lang === 'en' && EN[ja] !== undefined ? EN[ja] : ja, vars);
}
// server-made Japanese lines ("撃破 ×3", "デイリー：…", "称号「…」獲得")
export function tLine(s) {
  if (lang !== 'en') return s;
  if (EN[s] !== undefined) return EN[s];
  let m;
  if ((m = s.match(/^撃破 ×(\d+)$/))) return t('撃破 ×{n}', { n: m[1] });
  if ((m = s.match(/^命中 ×(\d+)$/))) return t('命中 ×{n}', { n: m[1] });
  if ((m = s.match(/^デイリー：(.+)$/))) return t('デイリー：{t}', { t: t(m[1]) });
  if ((m = s.match(/^称号「(.+)」獲得$/))) return t('称号「{t}」獲得', { t: t(m[1]) });
  return s;
}

// ---- static page text: remember each Japanese text node / attribute once, re-apply on switch
const JA = /[぀-ヿ一-鿿]/;
const nodes = [], attrs = [];
export function scanStatic(root = document.body) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const s = n.nodeValue.trim();
    if (s && JA.test(s) && EN[s] !== undefined && !n.parentElement?.closest('script,style')) nodes.push({ n, ja: n.nodeValue, key: s });
  }
  for (const el of root.querySelectorAll('[placeholder],[aria-label],[title]')) {
    for (const a of ['placeholder', 'aria-label', 'title']) {
      const v = el.getAttribute(a);
      if (v && EN[v] !== undefined) attrs.push({ el, a, key: v });
    }
  }
}
function applyStatic() {
  for (const x of nodes) x.n.nodeValue = lang === 'en' ? x.ja.replace(x.key, EN[x.key]) : x.ja;
  for (const x of attrs) x.el.setAttribute(x.a, t(x.key));
  document.documentElement.lang = lang;
}
const listeners = [];
export function onLang(fn) { listeners.push(fn); }
export function setLang(l) {
  lang = l === 'en' ? 'en' : 'ja';
  try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
  applyStatic();
  for (const fn of listeners) { try { fn(lang); } catch (e) { console.error(e); } }
}
export function initLang() { scanStatic(); applyStatic(); }

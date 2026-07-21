# kubota-seiko.com 変更履歴(計測用 page_version 対応)

計測イベントには `page_version` を付与しています。ページ改善の前後比較に使います。
大きな変更を1度にまとめず、変更単位を分けて記録してください。

| 変更日 | page_version | 変更箇所 | 変更理由 | 比較する指標 |
|---|---|---|---|---|
| 2026-07-22 | 202607_v1_launch | GA4計測基盤の初期実装(track.js/data属性/section_view/サンクスページ) | 公開後の動線・成果を計測開始 | 各セクション到達率・事例クリック率・申込クリック率・フォーム完了率 |

## page_versionの運用ルール
- HTMLの `<meta name="page-version" content="...">` を変更すると、以降の全イベントにその版が付く
- 命名例: `202607_v1_launch` / `202607_v2_cta_copy` / `202608_v3_works_layout`
- 変更したら上の表に1行追記する

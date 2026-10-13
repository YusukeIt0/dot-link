# MacにDot Linkをインストールする

[English](mac-install.md) · **日本語**

**Apple Silicon搭載・macOS 13以降のMac**が必要です。

| 方法 | こんな場合に |
| --- | --- |
| **ターミナルで導入（推奨）** | ダウンロード・整合性確認・正しい場所への配置をまとめて進めたい。下の手順へ。 |
| [Finderで導入（ZIPを手動で配置）](mac-install-finder.ja.md) | 自分でダウンロードしてアプリを移動したい。 |

どちらも**同じMacアプリ**が入ります。別の「CLI版」があるわけではありません。

## 1. ターミナルを開く

Spotlightで **ターミナル**を検索して開きます。コマンドの内容が気になったら、実行前にAIへ説明を求めても構いません。

## 2. コマンドをコピーして実行

**Mac 0.4.5/build 73**を入れます。公開ハッシュと署名の整合性を確認し、**自分のホーム内のアプリケーション**（`~/Applications`）へ配置します。既存のDot Linkがある場合は停止するので、アプリの **アップデートを確認**を使ってください。

```sh
(
  set -eu
  dotlink_destination="$HOME/Applications/Dot Link.app"
  if [ -e "$dotlink_destination" ] || [ -L "$dotlink_destination" ]; then
    echo 'Dot Link is already present. Use Check for updates in the app.' >&2
    exit 1
  fi
  dotlink_stage="$(mktemp -d "${TMPDIR:-/tmp}/dot-link-install.XXXXXX")"
  cd "$dotlink_stage"
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output Dot-Link.zip \
    'https://github.com/YusukeIt0/dot-link/releases/download/mac-v0.4.5-73/Dot-Link-0.4.5-73-arm64.zip'
  printf '%s  %s\n' \
    '82f9a0cdd9a578d4d49b1a01640ee0491d25e74eee75e9524bea99f8df7518c3' \
    'Dot-Link.zip' | shasum -a 256 -c -
  ditto -x -k Dot-Link.zip unpacked
  codesign --verify --deep --strict 'unpacked/Dot Link.app'
  mkdir -p "$HOME/Applications"
  mv -n 'unpacked/Dot Link.app' "$dotlink_destination"
  if [ -e 'unpacked/Dot Link.app' ]; then
    echo 'Destination appeared during installation; no app was replaced.' >&2
    exit 1
  fi
  open "$dotlink_destination"
)
```

これは上記バージョン専用で、将来の最新版を自動選択するものではありません。作業用の一時フォルダは実行後も残ります。整合性の確認は、Appleの公証や安全性の保証とは別です。

## 3. アプリを開いて準備

配置後にDot Linkが開きます。macOSに止められた場合は、[初回の警告への対応](mac-install-finder.ja.md#3-初回の警告が出たら)へ進んでください。Macのパスワード・Touch IDの確認も含めて案内しています。コマンドで隔離属性を削除したり、Gatekeeperを無効化したりする手順ではありません。

**このMacを準備する**を押し、約**490 MB**の音声認識データを取得します。**いつものDotと連携**が出たらMacの準備は完了です。続いて[Dotとの連携](dot-setup.md)、[iPhoneとの接続](setup.md#even)へ進みます。アカウントの接続設定や権限は、コマンドだけでは設定されません。

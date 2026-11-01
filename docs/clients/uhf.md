# UHF on Apple TV

UHF is a third-party app for Apple TV that plays IPTV and video-on-demand lists. NoConMedia presents itself as an Xtream Codes server, so UHF can use it. **This setup has not been tested by hand on a real Apple TV.** The steps below follow the general UHF flow and the text NoConMedia shows when you create a player; menu names may differ between UHF versions.

## Before you start

- The Apple TV and the NoConMedia server are on the same network (or the Apple TV's network is in `XTREAM_ALLOWED_CIDRS`; see [External players](../guides/xtream-clients.md#restrict-by-network)).
- Some videos are downloaded. Only downloaded videos on an online volume are listed.
- You have created a player in **Manage > External players** and kept its Server URL, Username and Password. Open the admin page using an address the Apple TV can reach (such as `http://nocon.local:3000`) before creating it, so the Server URL is correct. It looks like `http://192.168.1.50:3001`.

## Add the playlist in UHF

The dialog in NoConMedia gives these steps; use whichever names your UHF version shows:

1. Open UHF and go to Settings, then Add Channels (or "Add playlist").
2. Choose Xtream Codes.
3. Enter the server URL, username and password from NoConMedia. Enter the URL exactly as shown, including `http://` and `:3001`.
4. Save. The library appears under movies (VOD). Live TV and series are empty.

If your UHF version has no Xtream option, add the M3U URL instead (an "M3U playlist" or "URL" option). It is shown in the same dialog.

Passwords are 24 random characters, which is slow to type with the Apple TV remote. If your UHF version offers a way to enter the details from another device, use it.

## If it does not connect

Check, in order: the URL has the right host and port 3001; the password is the current one (rotating changes it); the player is not disabled or revoked; the Apple TV's IP is in an allowed network; Xtream is switched on in Settings. See [Troubleshooting](../guides/troubleshooting.md#an-xtream-client-cannot-connect).

## Manual compatibility checklist

Run this on a real Apple TV with a library of at least a few videos, one with subtitles if possible. Record Pass, Fail or Not applicable in the Result column, and add notes for anything that differs.

| # | Check | How to test | Result |
|---|---|---|---|
| 1 | Authentication | Add the Xtream account with the correct details. The account is accepted. Then try a wrong password and confirm it is rejected. | |
| 2 | Category retrieval | After adding, UHF lists categories such as Recently added and Favourites. | |
| 3 | Video listing | Opening a category lists the downloaded videos with titles. | |
| 4 | Artwork | Thumbnails show in the list and detail view. | |
| 5 | Metadata | Title, description, duration and release date appear in the detail view. | |
| 6 | Playback | A video starts and plays with sound, with no stutter on a wired connection. | |
| 7 | Seeking | Skipping forward and back, and jumping to the middle, works without restarting. | |
| 8 | Catalogue refresh | Download a new video, refresh the list in UHF, and the new video appears. | |
| 9 | Offline operation | Disconnect the server's internet connection (unplug the router's WAN, not the LAN) and repeat checks 2 to 7. | |
| 10 | Credential revocation | Revoke the player in NoConMedia. UHF can no longer list or play, and re-adding with the old password fails. | |

### Reporting results

Please report the completed table with:

- UHF version and Apple TV model with tvOS version.
- NoConMedia version (the `NOCON_VERSION` in `.env`, and the commit if you built from source).
- Whether Xtream or M3U was used.
- For any failure, the relevant lines from `docker compose logs api` around the time, with passwords removed (the API redacts credentials in URLs, but check before posting).

Add the results to this table, or open an issue on GitHub with the results. Until at least checks 1 to 7 pass, the README keeps the UHF test listed as outstanding.

# Install on a Raspberry Pi

This guide takes a Raspberry Pi 5 (or Pi 4) with a USB drive from a blank SD card to a running NoConMedia. It assumes you will manage the Pi over SSH. The guide was followed end to end on a Pi 4 with 2 GB of RAM on 5 November 2026; see [benchmarks](../benchmarks.md) for what that run measured. It has not been run on a Pi 5.

## What you need

- Raspberry Pi 5 (4 or 8 GB) or Pi 4 (4 or 8 GB). A Pi 4 with 2 GB also ran the lightweight profile, with the caveats under [Low memory](#low-memory-2-gb-pi).
- The official 27 W USB-C power supply for a Pi 5. A weaker supply makes the Pi limit power to USB devices, and a bus-powered drive may disconnect under load.
- An active cooler (the Pi 5 Active Cooler, or a case with a fan). Transcoding is off, but downloads, remuxing and the database still keep the CPU busy for long stretches.
- A microSD card of 16 GB or more for the operating system.
- A USB SSD or HDD for the library. An SSD is quieter and faster; an HDD works. A drive with its own power supply is safer than a bus-powered one.
- Wired Ethernet is recommended for streaming to a TV.

32-bit Raspberry Pi OS is not supported.

## Flash the operating system

1. In Raspberry Pi Imager, choose your Pi model.
2. Choose the operating system: **Raspberry Pi OS (other)**, then **Raspberry Pi OS Lite (64-bit)**. Menu names vary a little between Imager versions.
3. Choose the SD card.
4. When asked to customise settings, set a hostname (for example `nocon`), a username and password, your Wi-Fi details if you are not using Ethernet, your locale and time zone, and **enable SSH**.
5. Write the card, put it in the Pi and power it on.

Connect from your computer, using the username and hostname you chose:

```bash
ssh <username>@<hostname>.local
```

Then bring the system up to date and confirm it is 64-bit:

```bash
sudo apt update && sudo apt full-upgrade -y
uname -m
```

`uname -m` must print `aarch64`. If it prints `armv7l`, you installed the 32-bit image; reflash.

## Install Docker and git

The convenience script from Docker is the quickest route. Alternatively, follow Docker's apt repository instructions for Debian at <https://docs.docker.com/engine/install/debian/>.

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
sudo apt install -y git openssl
```

Log out and back in so the `docker` group applies, then check:

```bash
docker compose version
docker run --rm hello-world
```

## Prepare the USB drive

### Identify the drive

Plug the drive in and list block devices:

```bash
lsblk -f
```

Find the drive by its size. A USB drive normally appears as `sda` with a partition `sda1`. The SD card is `mmcblk0`. Be sure which one is which before the next step.

### Format it (this erases the drive)

**Formatting deletes everything on the drive.** Skip this section if the drive already holds an ext4 filesystem you want to keep, for example a library from a previous install.

```bash
sudo mkfs.ext4 -L nocon-media /dev/sda1
```

If the drive has no partition table, create one first with `sudo fdisk /dev/sda` (type `g` for GPT, `n` for a new partition, accept the defaults, `w` to write), then run the `mkfs.ext4` command on `/dev/sda1`. Replace `sda1` with your device name throughout.

### Find the UUID

```bash
sudo blkid /dev/sda1
```

Copy the value after `UUID=`. Mounting by UUID keeps the mount stable if the device name changes between boots.

### Mount it at /mnt/nocon-media

```bash
sudo mkdir -p /mnt/nocon-media
sudo nano /etc/fstab
```

Add this line at the end, with your own UUID:

```text
UUID=your-uuid-here /mnt/nocon-media ext4 defaults,noatime,nofail,x-systemd.device-timeout=10 0 2
```

`nofail` lets the Pi boot if the drive is missing. `x-systemd.device-timeout=10` stops the boot waiting longer than 10 seconds for it. `noatime` avoids writing a timestamp on every read.

```bash
sudo systemctl daemon-reload
sudo mount -a
findmnt /mnt/nocon-media
```

`findmnt` should show the device. If `mount -a` prints an error, fix the fstab line before rebooting.

### Give the containers access

The containers run as UID 1000. Make the drive writable by that user:

```bash
sudo chown 1000:1000 /mnt/nocon-media
```

## Turn on memory limits

Raspberry Pi OS does not enable the kernel's memory cgroup controller by default. Without it Docker ignores the memory limits in `compose.yml` (such as `WORKER_MEMORY`), `docker stats` shows `0B / 0B` for memory, and `docker info` and `docker compose up` print "Your kernel does not support memory limit capabilities". Check:

```bash
grep memory /proc/cgroups
```

If the last column is `0` or the line is missing, add `cgroup_enable=memory cgroup_memory=1` to the end of the single line in `/boot/firmware/cmdline.txt` (keep it one line), then reboot:

```bash
sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak
sudo sed -i '1s/$/ cgroup_enable=memory cgroup_memory=1/' /boot/firmware/cmdline.txt
sudo reboot
```

This is the usual fix for Raspberry Pi OS but has not been tested on the Pi used for the verification run. That run proceeded without limits, so the stack was not memory-capped.

## Install NoConMedia

```bash
git clone https://github.com/slaterjohn/nocon-media.git
cd nocon-media
scripts/install-pi.sh /mnt/nocon-media ./data
sudo chown -R 1000:1000 data
```

The script checks the architecture (it stops on 32-bit ARM), checks Docker, writes `.env` with a random `POSTGRES_PASSWORD` and `NOCON_PROXY_SECRET`, sets `MEDIA_PATH=/mnt/nocon-media` and `DATA_PATH` to the absolute path of `./data`, and prints reminders. It does not edit `/etc/fstab`, so the drive steps above are still yours to do.

Check `.env` contains these lines:

```text
MEDIA_PATH=/mnt/nocon-media
DEPLOYMENT_PROFILE=lightweight
```

If you want to adjust worker limits, `WORKER_CPUS=2.0` and `WORKER_MEMORY=1g` are the defaults and the example file suggests them for a Pi 4 or 5.

Build and start. The first build on a Pi takes several minutes: 9 minutes on a Pi 4 with 2 GB (SD card, Wi-Fi), most of it installing packages and compiling the web app.

```bash
docker compose up -d --build --wait
docker compose ps
```

### Without a USB drive

For a trial you can use a folder on the SD card, for example `sudo mkdir -p /srv/nocon-media && sudo chown 1000:1000 /srv/nocon-media`, and pass it to `scripts/install-pi.sh` in place of `/mnt/nocon-media`. The wizard accepts it (it reports the SD card as the filesystem). Video fills an SD card quickly and wears it, and the "drive unplugged" protection below does not apply, so use a drive for a real library.

## Run the setup wizard

Open `http://nocon.local:3000` (or the Pi's IP address) and follow the wizard described in [Install with Docker](install-docker.md#first-run-setup-wizard). Three choices matter on a Pi:

- **Storage:** keep the path `/media`. That is where `/mnt/nocon-media` appears inside the container. The validation panel should show a separate mount point and no warning about the container's own filesystem.
- **Deployment profile:** choose **Lightweight**. The wizard preselects Standard.
- **Default quality:** 1080p is the recommended default. YouTube serves H.264 only up to 1080p; higher resolutions arrive as VP9 or AV1, which are large and may not play on every device. The Pi never transcodes in real time.

### Choosing the lightweight profile

The worker takes its concurrency from the profile saved in the setup wizard or in **Settings > General**. `DEPLOYMENT_PROFILE` in `.env` (`lightweight` unless you change it) is only the default until a profile has been saved. In the lightweight profile it runs one download, one conversion and one metadata job at a time, checks discovery every 12 hours, uses small database pools, and skips generating thumbnails with ffmpeg. The standard profile runs three downloads, two conversions and three metadata jobs. A profile changed in Settings reaches the worker within about a minute; no restart is needed. `MAX_CONCURRENT_DOWNLOADS`, `MAX_CONCURRENT_PROCESSING` and `MAX_CONCURRENT_METADATA` in `.env`, if set, override the profile's numbers.

In the lightweight profile you may also want to turn off HLS preparation, which uses CPU and disk to make a segmented copy of files a browser cannot play directly. Turn off "HLS streaming" in **Settings > External player access > Advanced settings**, or set `ENABLE_HLS=false` in `.env`.

### Low memory (2 GB Pi)

On a Pi 4 with 2 GB the lightweight stack idled at about 420 MiB of process memory, with 35 MiB of swap in use, and the build finished without running out of memory. The standard profile, several concurrent downloads and HLS preparation were not tried on 2 GB and are likely to be tight. Raspberry Pi OS ships with a swap file; leave it enabled during the build.

## If the drive is unplugged

Every volume holds a marker file, `.noconmedia/volume.json`. The server checks it every minute. If the file is missing or does not match, because the drive was unplugged, failed or is not mounted:

- The volume turns Offline in **Storage** and **System health**, and a notification is raised.
- Downloads writing to it move to Paused. Nothing new is written.
- Nothing is deleted. Catalogue entries stay; the media shows as temporarily unavailable and is hidden from Xtream clients.
- Because the marker lives on the drive, an empty mount point on the SD card never passes as the library.

When the drive is back and mounted, the volume turns Online within a minute and paused downloads resume. You can select "Verify" on the volume in **Storage** to check straight away. If it stays offline after you have confirmed with `findmnt` that the drive is mounted, restart the containers so they see the new mount:

```bash
docker compose restart api worker
```

## Keeping the Pi healthy

- **System health** shows CPU, memory and the SoC temperature (read from `/sys/class/thermal/thermal_zone0/temp`). The page marks a warning above 70 °C and an alert above 80 °C. If it stays high, improve cooling before anything else.
- The worker runs `yt-dlp` and `ffmpeg` at a low priority (`nice 10`) so playback keeps responding.
- Take a backup before upgrades and every so often: [Backup and restore](backup-restore.md).
- Power cuts are survivable. See [recovery after an unexpected shutdown](backup-restore.md#recovery-after-an-unexpected-shutdown).

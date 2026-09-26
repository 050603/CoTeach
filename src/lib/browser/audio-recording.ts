/** Choose a container supported by this browser (Safari may only support MP4). */
export function createAudioRecorder(stream: MediaStream): MediaRecorder {
  if (typeof MediaRecorder === "undefined") throw new Error("当前浏览器不支持录音，请改用文字回答。");
  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
    .find((candidate) => MediaRecorder.isTypeSupported(candidate));
  return mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
}

export function audioRecordingFileName(mimeType: string, name = "recording"): string {
  const type = mimeType.split(";", 1)[0].toLowerCase();
  const extension = type === "audio/mp4" || type === "audio/x-m4a" ? "m4a"
    : type === "audio/ogg" ? "ogg"
      : type === "audio/wav" || type === "audio/x-wav" ? "wav"
        : type === "audio/mpeg" ? "mp3" : "webm";
  return `${name}.${extension}`;
}

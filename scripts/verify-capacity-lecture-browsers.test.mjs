import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { observeCapacityAudio, seedCapacityLectureScene } from './verify-capacity-lecture-browsers.mjs';

test('lecture fixture is student-facing, ordered before quizzes, and uses only supplied speech assets', () => {
  const lecture = seedCapacityLectureScene({ runId: 'capacity-12345678-1234-1234-1234-123456789abc', sectionId: 'section', audioUrl: '/api/uploads/audio', speechText: '真实讲解', repeatCount: 60 });
  assert.equal(lecture.scene.audience, 'student');
  assert.equal(lecture.scene.generationPurpose, 'knowledge-teaching');
  assert.equal(lecture.scene.lectureSectionId, 'section');
  assert.ok(lecture.scene.order < 0);
  assert.equal(lecture.scene.actions.length, 60);
  assert.equal(new Set(lecture.scene.actions.map(action => action.id)).size, 60);
  assert.ok(lecture.scene.actions.every(action => action.audioUrl === '/api/uploads/audio' && action.type === 'speech'));
  assert.throws(() => seedCapacityLectureScene({ runId: 'formal', sectionId: 'section', speechText: 'text' }));
});

test('native audio observation ignores unrelated media and seek resets without changing playback', () => {
  let playCalls = 0;
  class Audio extends EventTarget {
    src = ''; currentSrc = ''; currentTime = 0; seeking = false;
    play() { playCalls++; }
  }
  const window = { Audio };
  runInNewContext(`(${observeCapacityAudio.toString()})({ audioUrl: '/api/uploads/audio' })`, { window, location: { href: 'https://example.test/student/classroom/course' }, URL });
  const media = new window.Audio();
  media.src = 'https://example.test/api/uploads/audio?capacityClip=1';
  media.dispatchEvent(new Event('canplay')); media.dispatchEvent(new Event('playing'));
  for (const time of [0.3, 0.6, 1, 0, 0.4]) { media.currentTime = time; media.dispatchEvent(new Event('timeupdate')); }
  const unrelated = new window.Audio(); unrelated.src = 'https://example.test/unrelated';
  unrelated.currentTime = 2; unrelated.dispatchEvent(new Event('timeupdate'));
  const otherOrigin = new window.Audio(); otherOrigin.src = 'https://other.test/api/uploads/audio?capacityClip=2';
  otherOrigin.currentTime = 2; otherOrigin.dispatchEvent(new Event('timeupdate'));
  assert.equal(window.__capacityLectureAudio.canplay, 1);
  assert.equal(window.__capacityLectureAudio.playing, 1);
  assert.equal(window.__capacityLectureAudio.playedSeconds, 1.4);
  assert.equal(playCalls, 0);
  assert.ok(media instanceof Audio);
});

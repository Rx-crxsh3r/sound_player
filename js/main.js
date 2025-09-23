import { listen } from '@tauri-apps/api/event';

document.addEventListener('DOMContentLoaded', () => {
  const mainBar = document.getElementById('main-bar');
  const popupBox = document.getElementById('popup-box');
  const openPopupBtn = document.getElementById('open-popup-btn');
  const closePopupBtn = document.getElementById('close-popup-btn');

  const albumArtEl = document.getElementById('album-art');
  const trackTitleEl = document.getElementById('track-title');
  const trackArtistEl = document.getElementById('track-artist');
  const progressBarEl = document.getElementById('progress-bar');
  const trackTimeEl = document.getElementById('track-time');

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  function updateUI(state) {
    if (state.status === 'playing') {
      mainBar.classList.remove('idle');
      mainBar.classList.add('playing');
      albumArtEl.src = state.album_art_url;
      trackTitleEl.textContent = state.title;
      trackArtistEl.textContent = state.artist;
      trackTimeEl.textContent = `${formatTime(state.current_time)} / ${formatTime(state.total_time)}`;
      const progressPercent = (state.current_time / state.total_time) * 100;
      progressBarEl.style.width = `${progressPercent}%`;
    } else {
      mainBar.classList.add('idle');
      mainBar.classList.remove('playing');
    }
  }

  listen('media-update', (event) => {
    updateUI(event.payload);
  });

  openPopupBtn.addEventListener('click', () => {
    mainBar.classList.add('hidden');
    popupBox.classList.remove('hidden');
  });

  closePopupBtn.addEventListener('click', () => {
    popupBox.classList.add('hidden');
    mainBar.classList.remove('hidden');
  });
});

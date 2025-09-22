document.addEventListener('DOMContentLoaded', () => {
  const mainBar = document.getElementById('main-bar');
  const popupBox = document.getElementById('popup-box');
  const openPopupBtn = document.getElementById('open-popup-btn');
  const closePopupBtn = document.getElementById('close-popup-btn');

  openPopupBtn.addEventListener('click', () => {
    popupBox.style.display = 'flex';
    mainBar.style.display = 'none';
  });

  closePopupBtn.addEventListener('click', () => {
    popupBox.style.display = 'none';
    mainBar.style.display = 'flex';
  });
});

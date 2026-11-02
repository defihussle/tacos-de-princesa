/* ==========================================================================
   Tacos De Princesa — catering.js
   Sends the catering inquiry form (#catering-form) by email through
   EmailJS. The library is loaded from the CDN in catering.html's <head>.
   The form's name attributes (name, email, phone, event_date, guests,
   pickup_delivery, message) are the variables used in the EmailJS template.
   ========================================================================== */

(function () {
  'use strict';

  const EMAILJS_PUBLIC_KEY = 'kKh6lwEb6jHBxRO0l';
  const EMAILJS_SERVICE_ID = 'service_allcv3r';
  const EMAILJS_TEMPLATE_ID = 'template_ect5svm';

  const form = document.getElementById('catering-form');
  if (!form) return;

  const status = form.querySelector('[data-form-status]');
  const submit = form.querySelector('[type="submit"]');
  const submitLabel = submit.textContent;

  if (window.emailjs) {
    emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
  }

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    // CDN blocked or offline: don't pretend it was sent
    if (!window.emailjs) {
      setStatus('Sorry, the form couldn’t load. Please call 647-298-2267 or email Catering.tacosprincesa@gmail.com.');
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Sending…';
    setStatus('');

    emailjs.sendForm(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, form)
      .then(function () {
        form.reset();
        setStatus('Thanks! Your inquiry has been sent. Our catering team will be in touch soon.');
      })
      .catch(function () {
        setStatus('Sorry, something went wrong and your inquiry wasn’t sent. Please try again, or call 647-298-2267.');
      })
      .finally(function () {
        submit.disabled = false;
        submit.textContent = submitLabel;
      });
  });
})();

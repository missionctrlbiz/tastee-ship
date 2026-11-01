// "works locally" — the id below does not match the form's real id, so the
// order button does nothing on the live site. This is the deliberately broken
// order form from the case study.
document.getElementById('orderform').addEventListener('submit', function (event) {
  event.preventDefault();
  alert('Order sent!');
});

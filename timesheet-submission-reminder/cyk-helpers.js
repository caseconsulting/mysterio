function _isCykReminderDay() {
  return false;
}

async function _shouldSendCykEmployeeReminder(employee) {
  return false;
}

module.exports = {
  _isCykReminderDay,
  _shouldSendCykEmployeeReminder
};

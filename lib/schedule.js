var config = require('konfig')();

module.exports = {
	_getCurrentSchedule: function () {
		var schedule = config.app.Schedule;
		var currentDate = new Date();
		
		var dayOfWeek = currentDate.getDay();
		var daySchedule = schedule[dayOfWeek.toString()];

		return schedule[dayOfWeek.toString()];
	},
	_isOutOfSchedule: function() {
		var currentDate = new Date();
		var daySchedule = this._getCurrentSchedule();

		// TODO: Удалить завтра с утра
		if (currentDate.getDay() < 4) return false;

		// Quick hack, convert to Moscow timezone		
		var hourOfDay = currentDate.getHours() + 4;
		// 22:15 -> 23:00, compare later 23 < 18 || 23 > 22 -> true
		if (currentDate.getMinutes() > 0) hourOfDay = hourOfDay + 1;

		if (hourOfDay >= 24) hourOfDay = hourOfDay - 24;

		var range1 = daySchedule.timeRanges[0];
		var range2 = daySchedule.timeRanges[1];

		var outOfScheduleRequest = false;
		if (range1 && range2) {
			outOfScheduleRequest = (hourOfDay < range1.start || hourOfDay > range1.end) && (hourOfDay < range2.start || hourOfDay > range2.end);
		}
		else {
			outOfScheduleRequest = hourOfDay < range1.start || hourOfDay > range1.end;
		}
		return outOfScheduleRequest;
	},
	getSorryMsg: function () {
		var message = 'ОГРОМНОЕ спасибо за интерес к Instacab! Все автомобили в настоящее время заполнены, пожалуйста проверьте снова в ближайшее время!';
		if (this._isOutOfSchedule()) {
			message = "ОГРОМНОЕ спасибо за интерес к Instacab! Сегодня машины доступны с " + this._getCurrentSchedule().name + ". Пожалуйста попробуйте позже заказать еще раз.";
		}

		return message;		
	},
	getNoneAvailableString: function () {
		var message = "НЕТ СВОБОДНЫХ АВТОМОБИЛЕЙ";

		if (this._isOutOfSchedule()) {
			message = "Машины доступны сегодня с " + this._getCurrentSchedule().name;
		}
		return message;
	}
}
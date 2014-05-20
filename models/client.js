var util = require("util"),
	User = require("./user"),
	Driver = require("./driver").Driver,
	Cache = require('../lib/cache'),
	Repository = require('../lib/repository'),
	MessageFactory = require("../messageFactory"),
	ErrorCodes = require("../error_codes"),
	mongoClient = require("../mongo_client"),
	geofence = require("../lib/geofence");

function Client() {
	User.call(this, Client.LOOKING);	
}

util.inherits(Client, User);

var repository = new Repository(Client);

/**
 * Client States
 */

['Looking', 'Dispatching', 'WaitingForPickup', 'OnTrip', 'PendingRating'].forEach(function (readableState, index) {
	var state = readableState.toUpperCase();
  Client.prototype[state] = Client[state] = readableState;
});

/////////////////////////////////////////////////////
// Requests

Client.prototype.login = function(context, callback) {
	console.log('Client ' + this.id + ' login, ' + this.state);
	this.updateLocation(context);
	this.save();

	this._generateOKResponse(true, callback);
}

// Return client state and trip if any or available vehicles nearby
Client.prototype.ping = function(context, callback) {
	this.updateLocation(context);

	this._generateOKResponse(false, callback);
}

// TODO: Записывать событие в mongo.collection("dispatcher_events")
Client.prototype.pickup = function(context, callback) {
	this.updateLocation(context);
	if (this.state !== Client.LOOKING) return callback(null, this._createOK());

	if (!this.hasConfirmedMobile) {
		require('../backend').requestMobileConfirmation();
		return callback(null, this._createOK());
	}

	if (!Client.canRequestToLocation(context.message.pickupLocation)) {
		require('../backend').clientRequestPickup(this.id, { restrictedLocation: context.message.pickupLocation });

		return callback(null, MessageFactory.createClientOK(this, { sorryMsg: "К сожалению мы еще не работаем в вашей области. Мы постоянно расширяем наш сервис, следите за обновлениями вступив в группу vk.com/instacab" }));
	}

	Driver.availableSortedByDistanceFrom(context.message.pickupLocation, function(err, items){
		if (err) return callback(err);

		if (items.length === 0) {
			require('../backend').clientRequestPickup(this.id, { noCarsAvailable: true });

			return callback(null, MessageFactory.createClientOK(this, { sorryMsg: 'ОГРОМНОЕ спасибо за интерес к Instacab! Все автомобили в настоящее время заполнены, пожалуйста проверьте снова в ближайшее время!' }));
		}

		this._driversAvailableForDispatch(context.message.pickupLocation, items, callback);
	}.bind(this));
}

Client.prototype._driversAvailableForDispatch = function(pickupLocation, items, callback) {
	require("./trip").Trip.create(function(err, trip) {
		// Check again for driver availability, when two pickup requests come at the same time, some client
		// can already claim first driver
		var driverFound = items.some(this._dispatchFirstAvailableDriver.bind(this, trip, pickupLocation));

		if (driverFound) {
			callback(null, this._createOK());
		}
		// No drivers
		else {
			require('../backend').clientRequestPickup(this.id, { noCarsAvailable: true, secondCheck: true });

			return callback(null, MessageFactory.createClientOK(this, { sorryMsg: 'Спасибо БОЛЬШОЕ за интерес к Instacab. Все автомобили в настоящее время заполнены, пожалуйста проверьте снова в ближайшее время!' }));
		}

	}.bind(this));
}

Client.prototype._dispatchFirstAvailableDriver = function(trip, pickupLocation, item) {
	if (!item.driver.isAvailable()) return false;

	trip.pickup(this, pickupLocation, item.driver);

	this.setTrip(trip);
	this.changeState(Client.DISPATCHING);
	this.save();
	
	return true;
}

// Отменить заказ на поездку
Client.prototype.cancelPickup = function(context, callback) {
	this.updateLocation(context);
	
	if (this.state === Client.DISPATCHING || this.state === Client.WAITINGFORPICKUP) {
		this.trip.pickupCanceledClient();
		this.changeState(Client.LOOKING);
		this.save();
	}

	this._generateOKResponse(false, callback);
}

// Client explicitly canceled trip
Client.prototype.cancelTrip = function(context) {
	this.updateLocation(context);	

	if (this.state === Client.WAITINGFORPICKUP) {
		this.changeState(Client.LOOKING);
		this.save();
	}
	
	// TODO: Вызвать this._generateOKResponse(false, callback);
	// Чтобы после отмены клиент получил обновленные позиции машин
	return MessageFactory.createClientOK(this);
}

Client.prototype.rateDriver = function(context, callback) {
	this.updateLocation(context);

	if (this.state === Client.PENDINGRATING) {
		require('../backend').rateDriver(this.trip.id, context.message.rating, context.message.feedback, function() {
			this.changeState(Client.LOOKING);
			this.save();

			this._generateOKResponse(false, callback);
		}.bind(this));
	}
	else 
		this._generateOKResponse(false, callback);
}

/////////////////////////////////////////////////////
// Notifications

Client.prototype.notifyDriverConfirmed = function() {
	if (this.state !== Client.DISPATCHING) return;
		
	this.changeState(Client.WAITINGFORPICKUP);
	this.save();
	
	require('../backend').smsTripStatusToClient(this.trip, this);		
	
	this.send(MessageFactory.createClientOK(this, { trip: this.trip }));
}

// Driver pressed 'Begin Trip' to start trip
Client.prototype.notifyTripStarted = function() {
	if (this.state !== Client.WAITINGFORPICKUP) return;
	
	this.changeState(Client.ONTRIP);

	// TODO: Remove after updating iOS client app
	this.send(MessageFactory.createTripStarted(this, this.trip));

	// Web Mobile Client
	this._generateOKResponse(false, function(err, response) {
		this.send(response);
	}.bind(this));

	this.save();
}

// TODO: Просто возвращать одного водителя, назначенного в заказе в поле nearbyVehicles
Client.prototype.notifyDriverEnroute = function() {
	if (this.state === Client.WAITINGFORPICKUP || this.state === Client.ONTRIP) {
		this._generateOKResponse(false, function(err, response) {
			this.send(response);
		}.bind(this));

		// TODO: Remove after updating iOS client app
		this.send(MessageFactory.createClientDriverEnroute(this.trip));
	}
}

// Notify client that driver canceled trip
Client.prototype.notifyTripCanceled = function() {
	if (this.state !== Client.WAITINGFORPICKUP) return;

	require('../backend').smsTripStatusToClient(this.trip, this);

	// nulls out this.trip
	this.changeState(Client.LOOKING);	

	this.send(MessageFactory.createClientTripCanceled(this, "Водитель был вынужден отменить твой заказ, но возможно у нас есть еще один свободный Instacab! Пожалуйста попробуй снова заказать машину."));

	this.save();
}

Client.prototype.notifyDriverArriving = function() {
	if (this.state !== Client.WAITINGFORPICKUP) return;
	
	// TODO: Remove after updating iOS client app
	this.send(MessageFactory.createArrivingNow(this.trip));

	// Web Mobile Client
	this._generateOKResponse(false, function(err, response) {
		this.send(response);
	}.bind(this));

	require('../backend').smsTripStatusToClient(this.trip, this);
}

Client.prototype.notifyTripFinished = function() {
	if (this.state !== Client.ONTRIP) return;

	this.changeState(Client.PENDINGRATING);
	this.save();

	// TODO: Remove after updating iOS client app
	this.send(MessageFactory.createClientEndTrip(this, this.trip))

	// Web Mobile Client
	this._generateOKResponse(false, function(err, response) {
		this.send(response);
	}.bind(this));	
}

// Notify client that pickup request was canceled
Client.prototype.notifyPickupCanceled = function(reason) {
	if (this.state !== Client.DISPATCHING) return;

 	console.log('Cancel client ' + this.id + ' pickup');

	this.changeState(Client.LOOKING);
	this.save();
	this.send(MessageFactory.createClientPickupCanceled(this, reason));
}

Client.prototype.notifyTripBilled = function() {
	this.send(this._createOK());
}

//////////////////////////////////////////
// Utility methods

Client.prototype._createOK = function(includeToken) {
	var options = {
		includeToken: includeToken || false,
		trip: this.trip,
		tripPendingRating: this.state === Client.PENDINGRATING
	}

	return MessageFactory.createClientOK(this, options);
}

Client.prototype._generateOKResponse = function(includeToken, callback) {
	// Return only one vehicle when client waits for pickup or already on the trip
	if (this.state === Client.WAITINGFORPICKUP || this.state === Client.ONTRIP) {
		var vehicle = {
		  id: this.trip.driver.vehicle.id,
		  longitude: this.trip.driver.location.longitude, 
		  latitude: this.trip.driver.location.latitude,
		  epoch: this.trip.driver.location.epoch,
		  course: this.trip.driver.location.course,
		  eta: 0 // TODO: Позже можно динамически считать ETA водителя (скажем каждые 500 метров)
		};

		var message = MessageFactory.createClientOK(this, { includeToken: includeToken, trip: this.trip, vehicles: [vehicle] });
		callback(null, message);
	}
	// Return all vehicles nearby client location
	else if (this.state === Client.LOOKING) {
		this._updateNearbyDrivers({ includeToken: includeToken }, callback);
	}
	// Return current client state
	else {
		callback(null, this._createOK(includeToken))
	}
}

Client.prototype.getSchema = function() {
  var props = User.prototype.getSchema.call(this);
  props.push('paymentProfile');
  props.push('hasConfirmedMobile');
  return props;
}

Client.prototype.save = function(callback) {
	repository.save(this, callback);
}

Client.prototype.changeState = function(state) {
  User.prototype.changeState.call(this, state);
  
  if (this.state === Client.LOOKING) {
    this.clearTrip();
  }
}

// TODO: Обновилась позиция всего одного водителя и не нужно пересчитывать расстояние и время прибытия
// всех остальных
//  Notify client about changes in nearby vehicles
Client.prototype.updateNearbyDrivers = function() {
	if (!this.connected || this.state !== Client.LOOKING) return;
	
	console.log('Update nearby drivers for client ' + this.id + ', connected: ' + this.connected + ', state: ' + this.state);
	this._updateNearbyDrivers({}, function(err, response) {
		this.send(response);
	}.bind(this));
}

Client.prototype._updateNearbyDrivers = function(options, callback) {
	Driver.allAvailableNear(this.location, function(err, vehicles) {
		options.vehicles = vehicles;
		callback(err, MessageFactory.createClientOK(this, options));
	}.bind(this));
}

Client.prototype.toJSON = function() {
  var obj = User.prototype.toJSON.call(this);
  if (this.trip) {
    obj.pickupLocation = this.trip.pickupLocation;
  }
  return obj;
}

Client.publishAll = function() {
  repository.all(function(err, user) {
    user.forEach(function(user) {
      user.publish();
    });
  });
}

Client.canRequestToLocation = function(location) {
	return geofence.isLocationAllowed(location);
}

// export Client constructor
module.exports.Client = Client;
module.exports.repository = repository;
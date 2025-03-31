/*
 * Smart Glove Demo v1.0
 *
 * Copyright (C) 2025 Soothsayer Systems Ltd. All rights reserved.
 *
 * Author: Tom Coates <tom@soothsys.com>
 */

const DEVICE_NAME = 'SmartGlove';
const IS_LITTLE_ENDIAN = true; //BLE protocol is little endian
const NAME_DESCRIPTOR_UUID = BluetoothUUID.canonicalUUID('0x2901');
const PRES_DESCRIPTOR_UUID = BluetoothUUID.canonicalUUID('0x2904');
const PRES_DESCRIPTOR_LENGTH = 7; //bytes

/*
 * GATT format types defined in Bluetooth Assigned Numbers specification, section 2.4.1
 * https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Assigned_Numbers/out/en/Assigned_Numbers.pdf
 */
const BLE_FORMAT_BOOLEAN = 0x01;
const BLE_FORMAT_UINT8 = 0x04;
const BLE_FORMAT_UINT16 = 0x06;
const BLE_FORMAT_UINT32 = 0x08;
const BLE_FORMAT_SINT8 = 0x0C;
const BLE_FORMAT_SINT16 = 0x0E;
const BLE_FORMAT_SINT32 = 0x10;
const BLE_FORMAT_FLOAT32 = 0x14;

const BLE_UNITS = new Map([
	[0x2700, ''], //Unitless
	[0x2713, 'm/s2'],
	[0x2720, 'rad'],
	[0x2724, 'Pa'],
	[0x2728, 'V'],
	[0x272D, 'uT'],
	[0x272F, '°C'],
	[0x2743, 'rad/s'],
	[0x27AD, '%'],
	[0x27C4, 'ppm'],
	[0x27C5, 'ppb']
]);

const supportedServices = new Map([
	[BluetoothUUID.canonicalUUID(0x180F), 'Battery'],
	[BluetoothUUID.canonicalUUID(0x181A), 'Environmental Sensor'],
	[BluetoothUUID.canonicalUUID(0x054D), 'Light Sensor'],
	['606a0692-1e69-422a-9f73-de87d239aade', 'Inertial Measurement Unit'],
	['7749eb1b-2b16-4d32-8422-e792dae7adb8', 'Magnetic Field Sensor']
]);

const readCharacteristicList = new Map();
const writeCharacteristicList = new Map();
const log = new Map();

const statusBox = document.getElementById('statusBox');
const statusMessage = document.getElementById('statusMessage');
const txtStatus = document.getElementById('txtStatus');
const bttnConnect = document.getElementById('bttnConnect');
const bttnLogStart = document.getElementById('bttnLogStart');
const bttnLogStop = document.getElementById('bttnLogStop');
const logPeriod = document.getElementById('logPeriod');
const servicesArea = document.getElementById('servicesArea');

let bleServer;
let logTimer;

bttnConnect.addEventListener('click', bluetoothConnect);
bttnLogStart.addEventListener('click', logStart);
bttnLogStop.addEventListener('click', logStop);

function statusReady(message = '') {
	statusBox.className = 'status ready';
	statusMessage.innerHTML = message;
}

function statusOk(message = '') {
	statusBox.className = 'status ok';
	statusMessage.innerHTML = message;
}

function statusFail(message = '') {
	statusBox.className = 'status fail';
	statusMessage.innerHTML = message;
}

function disableButton(bttn) {
	bttn.disabled = true;
	bttn.classList.add('disabled');
}

function enableButton(bttn) {
	bttn.disabled = false;
	bttn.classList.remove('disabled');
}

function bluetoothConnect() {
	if (bleServer && bleServer.connected) {
		console.log('Already connected');
		return;
	}

	if (!navigator.bluetooth) {
		statusFail('This browser does not support Web Bluetooth. Please try another browser.');
		return;
	}

	readCharacteristicList.clear();
	writeCharacteristicList.clear();

	disableButton(bttnConnect);
	console.log('Opening Bluetooth connection...');
	navigator.bluetooth.requestDevice({
		filters: [{ name: DEVICE_NAME }],
		optionalServices: getSupportedUuids()
	}).then(device => {
		console.log('Connected to: ', device.name);
		statusOk('Connected to ' + device.name);
		enableButton(bttnLogStart);
		disableButton(bttnLogStop);
		device.addEventListener('gattservicedisconnected', onDisconnect);
		return device.gatt.connect();
	}).then(gattServer => {
		bleServer = gattServer;
		console.log('GATT server connected');
		return bleServer.getPrimaryServices();
	}).then(services => initServices(services))
	.catch(error => {
		if (bleServer && bleServer.connected) {
			bleServer.disconnect();
		}

		console.log('Error connecting to Bluetooth device: ', error);
		statusFail('Error connecting to Bluetooth device');
		enableButton(bttnConnect);
	});
}

function onDisconnect(event) {
	console.log('Disconnected from: ', event.target.device.name);
	statusReady('Disconnected');
	servicesArea.replaceChildren();
	logStop();
	disableButton(bttnLogStart);
	enableButton(bttnConnect);
}

function getSupportedUuids() {
	const keys = supportedServices.keys();
	return Array.from(keys);
}

function initServices(services) {
	for (const service of services) {
		if (supportedServices.has(service.uuid)) {
			const serviceName = supportedServices.get(service.uuid);
			console.log('Found service "', serviceName, '" with UUID "', service.uuid, '"');

			const table = showService(service.uuid, serviceName);
			service.getCharacteristics().then(characteristics => initCharacteristics(table, serviceName, characteristics));
		} else {
			console.log('Found unsupported service with UUID "', service.uuid, '"');
		}
	}
}

function initCharacteristics(table, serviceName, characteristics) {
	const decoder = new TextDecoder();
	for (const characteristic of characteristics) {
		let characteristicName = '';
		characteristic.getDescriptor(NAME_DESCRIPTOR_UUID).then(nameDescriptor => {
			return nameDescriptor.readValue();
		}).then(arrBuffer => {
			characteristicName = decoder.decode(arrBuffer);
			console.log('Found characteristic "', characteristicName, '" with UUID "', characteristic.uuid, '"');

			//All characteristics should have Read and Notify properties set at minimum, ignore any that don't
			if (characteristic.properties.read && characteristic.properties.notify) {			
				if (characteristic.properties.write) { //Writeable characteristics should also have Write property set
					initWriteCharacteristic(table, characteristic, characteristicName);
				} else { //Otherwise it must be a read-only characteristic
					initReadCharacteristic(table, serviceName, characteristic, characteristicName);
				}
			}
		});
	}
}

function initReadCharacteristic(table, serviceName, characteristic, characteristicName) {
	characteristic.getDescriptor(PRES_DESCRIPTOR_UUID).then(presDescriptor => {
		return presDescriptor.readValue();
	}).then(presDataView => {
		const presInfo = readPresInfo(presDataView);
		if (presInfo) {
			characteristic.readValue().then(valDataView => {
				const characteristicInfo = {
					name: characteristicName,
					serviceName: serviceName,
					presInfo: presInfo,
					lastEntry: ''
				};

				readCharacteristicList.set(characteristic.uuid, characteristicInfo);
				showReadCharacteristic(table, characteristic.uuid, characteristicName);
				updateVal(characteristic.uuid, valDataView, presInfo);
				characteristic.addEventListener('characteristicvaluechanged', onNotify);
				characteristic.startNotifications();
				console.log('Started notifications for UUID "', characteristic.uuid, '"');
			});
		}
	});
}

function initWriteCharacteristic(table, characteristic, characteristicName) {
	writeCharacteristicList.set(characteristic.uuid, characteristic);
	showWriteCharacteristic(table, characteristic.uuid, characteristicName);
	characteristic.startNotifications();
	console.log('Started notifications for UUID "', characteristic.uuid, '"');
}

function readPresInfo(dataView) {
	if (dataView.byteLength < PRES_DESCRIPTOR_LENGTH) {
		console.log('Characteristic presentation descriptor received was in invalid format');
	} else {
		const presInfo = {};
		presInfo.format = dataView.getUint8(0);
		presInfo.exponent = dataView.getInt8(1);
		presInfo.unit = dataView.getUint16(2, IS_LITTLE_ENDIAN);
		return presInfo;
	}
}

function showService(uuid, serviceName) {
	let serviceDiv = document.createElement('div');
	serviceDiv.id = uuid;
	serviceDiv.className = 'serviceBox';
	servicesArea.appendChild(serviceDiv);

	let table = document.createElement('table');
	serviceDiv.appendChild(table);

	let titleRow = document.createElement('tr');
	table.appendChild(titleRow);

	let titleCell = document.createElement('td');
	titleCell.colSpan = 2;
	titleCell.className = 'serviceName';
	titleCell.innerHTML = serviceName;
	titleRow.appendChild(titleCell);
	
	return table;
}

function showReadCharacteristic(table, uuid, characteristicName) {
	let row = document.createElement('tr');
	table.appendChild(row);

	let nameCell = document.createElement('td');
	nameCell.innerHTML = characteristicName + ': ';
	row.appendChild(nameCell);

	let valCell = document.createElement('td');
	valCell.id = uuid;
	valCell.innerHTML = 'No data';
	row.appendChild(valCell);
}

function showWriteCharacteristic(table, uuid, characteristicName) {
	let row = document.createElement('tr');
	table.appendChild(row);

	let cell = document.createElement('td');
	cell.colSpan = 2;
	row.appendChild(cell);

	let bttn = document.createElement('button');
	bttn.type = 'button';
	bttn.id = uuid;
	bttn.innerHTML = characteristicName;
	bttn.addEventListener('click', onClick);
	cell.appendChild(bttn);
}

function onNotify(event) {
	if (!readCharacteristicList.has(event.target.uuid)) {
		console.log('Received notification for unknown UUID "', event.target.uuid, '"');
	} else {
		const charInfo = readCharacteristicList.get(event.target.uuid);
		updateVal(event.target.uuid, event.target.value, charInfo.presInfo);
	}
}

function onClick(event) {
	if (writeCharacteristicList.has(event.target.id)) {
		let characteristic = writeCharacteristicList.get(event.target.id);
		characteristic.readValue().then(dataView => {
			if (dataView.byteLength >= 1) {
				let val = dataView.getUint8(0);
				dataView.setUint8(0, !val); //Invert the value...
				characteristic.writeValueWithoutResponse(dataView.buffer); //...then write it back
			}
		});
	}
}

function updateVal(characteristicUuid, dataView, presInfo) {
	const valCell = document.getElementById(characteristicUuid);
	if (!valCell) {
		console.log('No target cell found for UUID "', uuid, '"');
	} else {
		let val = readValue(dataView, presInfo);
		val = formatValue(val, presInfo);
		cacheValue(characteristicUuid, val);
		valCell.innerHTML = val + ' ' + getUnitString(presInfo);
	}
}

function readValue(dataView, presInfo) {
	let length;
	let decodeFunc;
	switch (presInfo.format) {
		case BLE_FORMAT_BOOLEAN:
			length = 1;
			decodeFunc = (x) => { return (x.getUint8(0) != 0); };
			break;

		case BLE_FORMAT_UINT8:
			length = 1;
			decodeFunc = (x) => { return x.getUint8(0); };
			break;

		case BLE_FORMAT_UINT16:
			length = 2;
			decodeFunc = (x) => { return x.getUint16(0, IS_LITTLE_ENDIAN); };
			break;

		case BLE_FORMAT_UINT32:
			length = 4;
			decodeFunc = (x) => { return x.getUint32(0, IS_LITTLE_ENDIAN); };
			break;

		case BLE_FORMAT_SINT8:
			length = 1;
			decodeFunc = (x) => { return x.getInt8(0); };
			break;

		case BLE_FORMAT_SINT16:
			length = 2;
			decodeFunc = (x) => { return x.getInt16(0, IS_LITTLE_ENDIAN); };
			break;

		case BLE_FORMAT_SINT32:
			length = 4;
			decodeFunc = (x) => { return x.getInt32(0, IS_LITTLE_ENDIAN); };
			break;

		case BLE_FORMAT_FLOAT32:
			length = 4;
			decodeFunc = (x) => { return x.getFloat32(0, IS_LITTLE_ENDIAN); };
			break;

		default:
			return 0;
	}

	if (dataView.byteLength < length) {
		console.log('Characteristic value length does not match format specified in client presentation descriptor');
		return 0;
	}

	let rawVal = 0;
	if (decodeFunc) {
		rawVal = decodeFunc(dataView);
	}

	if (presInfo.format == BLE_FORMAT_BOOLEAN) { //Ignore exponent for boolean
		return rawVal;
	} else {
		const scaleFactor = 10 ** presInfo.exponent;
		return rawVal * scaleFactor;
	}
}

function formatValue(val, presInfo) {
	if (presInfo.format == BLE_FORMAT_BOOLEAN) {
		return val;
	} else {
		let numDecimals = -presInfo.exponent;
		if (numDecimals < 0) {
			numDecimals = 0;
		} else if (numDecimals > 100) {
			numDecimals = 100;
		}

		return val.toFixed(numDecimals);
	}
}

function getUnitString(presInfo) {
	if (BLE_UNITS.has(presInfo.unit)) {
		return BLE_UNITS.get(presInfo.unit);
	} else {
		console.log('Unknown BLE unit definition "', presInfo.unit, '"');
		return '';
	}
}

function cacheValue(characteristicUuid, valStr) {
	if (readCharacteristicList.has(characteristicUuid)) {
		const characteristicInfo = readCharacteristicList.get(characteristicUuid);
		characteristicInfo.lastEntry = valStr;
	}
}

function logStart() {
	disableButton(bttnLogStart);
	enableButton(bttnLogStop);
	log.clear();
	logTimer = setInterval(updateLog, logPeriod.value);
}

function logStop() {
	enableButton(bttnLogStart);
	disableButton(bttnLogStop);
	clearInterval(logTimer);

	if (log.size > 0) {
		const logstr = printLog();
		saveLog(logstr);
	}
}

function updateLog() {
	const logEntry = new Map();
	readCharacteristicList.forEach((characteristicInfo, uuid, map) => {
		logEntry.set(uuid, characteristicInfo.lastEntry);
	});

	const timestamp = printTimestamp();
	log.set(timestamp, logEntry);
}

function printLog() {
	let csv = 'Timestamp,';
	let line2 = ',';
	let line3 = ',';
	readCharacteristicList.forEach((characteristicInfo, uuid, map) => {
		csv += characteristicInfo.serviceName + ',';
		line2 += characteristicInfo.name + ',';
		if (readCharacteristicList.has(uuid)) {
			const charInfo = readCharacteristicList.get(uuid);
			line3 += getUnitString(charInfo.presInfo);
		}

		line3 += ',';
	});

	csv += '\n' + line2 + '\n' + line3;

	log.forEach((logEntry, timestamp, map) => {
		csv += '\n' + timestamp + ',';
		readCharacteristicList.forEach((characteristicInfo, uuid, charactertisticMap) => {
			if (logEntry.has(uuid)) {
				csv += logEntry.get(uuid);
			}

			csv += ',';
		});
	});

	csv += '\n';
	return csv;
}

function printTimestamp() {
	const timestamp = new Date();
	let str = timestamp.getFullYear() + '/';
	str += doPad(timestamp.getMonth() + 1) + '/'; //JS uses zero-indexed months for some reason
	str += doPad(timestamp.getDate()) + ' ';
	str += doPad(timestamp.getHours()) + ':';
	str += doPad(timestamp.getMinutes()) + ':';
	str += doPad(timestamp.getSeconds());
	return str;
}

function doPad(num) {
	return num.toString().padStart(2, 0);
}

function saveLog(logstr) {
	const element = document.createElement('a');
	element.setAttribute('href', 'data:text/csv;charset=utf-8,' + encodeURIComponent(logstr));
	element.setAttribute('download', 'log.csv');
	element.style.display = 'none';
	document.body.appendChild(element);
	element.click();
	document.body.removeChild(element);
}

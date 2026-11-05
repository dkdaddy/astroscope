// Motor driver connections (Nano to ULN2003)
const uint8_t PIN_IN1 = 8;
const uint8_t PIN_IN2 = 9;
const uint8_t PIN_IN3 = 10;
const uint8_t PIN_IN4 = 11;

// Potentiometer pins
const uint8_t PIN_POT_PWR = 5;  // Supplies 5V rail to potentiometer
const uint8_t PIN_POT     = A5; // Wiper read (analog-only pin)

// Potentiometer deadband and motion configuration
const int ADC_CENTER = 512;
const int ADC_DEADBAND = 30;     // Deadband: 512 +/- 30 (482 to 542)
const int MAX_STEP_RATE = 1000;  // Max half-steps per second

// 8-step excitation lookup table
const uint8_t STEP_PHASES[8][4] = {
  {1, 0, 0, 0},
  {1, 1, 0, 0},
  {0, 1, 0, 0},
  {0, 1, 1, 0},
  {0, 0, 1, 0},
  {0, 0, 1, 1},
  {0, 0, 0, 1},
  {1, 0, 0, 1}
};

int16_t targetSpeed = 0;
int16_t serialSpeed = 0;
uint32_t stepIntervalMicros = 0;
uint32_t lastStepMicros = 0;
uint32_t lastSerialMillis = 0;
int8_t currentStepPhase = 0;

const uint32_t SERIAL_WATCHDOG_MS = 500;

void depowerMotor() {
  digitalWrite(PIN_IN1, LOW);
  digitalWrite(PIN_IN2, LOW);
  digitalWrite(PIN_IN3, LOW);
  digitalWrite(PIN_IN4, LOW);
}

void setCoilState(int8_t phaseIndex) {
  digitalWrite(PIN_IN1, STEP_PHASES[phaseIndex][0]);
  digitalWrite(PIN_IN2, STEP_PHASES[phaseIndex][1]);
  digitalWrite(PIN_IN3, STEP_PHASES[phaseIndex][2]);
  digitalWrite(PIN_IN4, STEP_PHASES[phaseIndex][3]);
}

void applySpeed(int16_t speed) {
  speed = constrain(speed, -MAX_STEP_RATE, MAX_STEP_RATE);
  targetSpeed = speed;

  if (targetSpeed == 0) {
    stepIntervalMicros = 0;
    depowerMotor();
  } else {
    stepIntervalMicros = 1000000UL / (uint32_t)abs(targetSpeed);
  }
}

int16_t readPotentiometerSpeed() {
  int raw = analogRead(PIN_POT);
  int deviation = raw - ADC_CENTER;

  if (abs(deviation) <= ADC_DEADBAND) {
    return 0;
  }

  int activeRange = ADC_CENTER - ADC_DEADBAND;
  float normalized = (float)(abs(deviation) - ADC_DEADBAND) / (float)activeRange;
  normalized = constrain(normalized, 0.0f, 1.0f);

  int16_t speed = (int16_t)(normalized * normalized * MAX_STEP_RATE);
  return (deviation > 0) ? speed : -speed;
}

void processCommand(char* cmd) {
  lastSerialMillis = millis();

  if (cmd[0] == 'V' || cmd[0] == 'v') {
    serialSpeed = atoi(cmd + 1);
    Serial.print(F("OK V:"));
    Serial.println(serialSpeed);
  } else if (cmd[0] == 'H' || cmd[0] == 'h') {
    serialSpeed = 0;
    Serial.println(F("OK HALT"));
  }
}

void checkSerial() {
  static char buffer[32];
  static uint8_t idx = 0;

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (idx > 0) {
        buffer[idx] = '\0';
        processCommand(buffer);
        idx = 0;
      }
    } else {
      if (idx < sizeof(buffer) - 1) {
        buffer[idx++] = c;
      }
    }
  }
}

void executeStep() {
  if (targetSpeed == 0) return;

  uint32_t now = micros();
  if (now - lastStepMicros >= stepIntervalMicros) {
    lastStepMicros = now;

    if (targetSpeed > 0) {
      currentStepPhase++;
      if (currentStepPhase > 7) currentStepPhase = 0;
    } else {
      currentStepPhase--;
      if (currentStepPhase < 0) currentStepPhase = 7;
    }
    setCoilState(currentStepPhase);
  }
}

void setup() {
  Serial.begin(115200);

  // Configure D4 as high rail for the pot
  pinMode(PIN_POT_PWR, OUTPUT);
  digitalWrite(PIN_POT_PWR, HIGH);

  // Note: A6 is an analog-only pin; no pinMode() call is required or supported.

  pinMode(PIN_IN1, OUTPUT);
  pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_IN3, OUTPUT);
  pinMode(PIN_IN4, OUTPUT);

  depowerMotor();
  lastSerialMillis = millis();
}

void loop() {
  checkSerial();

  if (serialSpeed != 0 && (millis() - lastSerialMillis > SERIAL_WATCHDOG_MS)) {
    serialSpeed = 0;
  }

  int16_t potSpeed = readPotentiometerSpeed();

  if (potSpeed != 0) {
    applySpeed(potSpeed);
  } else {
    applySpeed(serialSpeed);
  }
  executeStep();
}
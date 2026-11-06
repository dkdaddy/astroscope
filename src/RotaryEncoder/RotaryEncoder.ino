// 5-pin rotary encoder (KY-040 style) -> Serial
//
// Wiring (Arduino Nano / Uno):
//   Encoder GND -> GND
//   Encoder +   -> 5V
//   Encoder SW  -> D4   (push button, active LOW)
//   Encoder DT  -> D3   (channel B, interrupt pin)
//   Encoder CLK -> D2   (channel A, interrupt pin)
//
// Serial protocol (115200 baud, one message per line):
//   READY        sent once at startup
//   POS:<n>      absolute detent position, sent whenever it changes
//   BTN:1/BTN:0  push button pressed / released

const uint8_t PIN_CLK = 2;
const uint8_t PIN_DT  = 3;
const uint8_t PIN_SW  = 4;

// Most KY-040 encoders produce one full quadrature cycle (4 edges) per detent.
const int8_t STEPS_PER_DETENT = 4;
// Set to true if clockwise rotation counts down on your encoder.
const bool REVERSE = false;

const unsigned long DEBOUNCE_MS = 20;

// Quadrature transition table indexed by (previousState << 2) | currentState.
// Invalid transitions (both bits changing, i.e. bounce/noise) contribute 0.
const int8_t QUAD_TABLE[16] = {
   0, -1,  1,  0,
   1,  0,  0, -1,
  -1,  0,  0,  1,
   0,  1, -1,  0
};

volatile long rawCount = 0;
volatile uint8_t lastAB = 0;

long lastPosition = 0;
bool buttonState = HIGH;
bool lastButtonReading = HIGH;
unsigned long lastButtonChange = 0;

void encoderISR() {
  uint8_t ab = (digitalRead(PIN_CLK) << 1) | digitalRead(PIN_DT);
  rawCount += QUAD_TABLE[(lastAB << 2) | ab];
  lastAB = ab;
}

// Floor division that behaves correctly for negative numbers.
long floorDiv(long n, long d) {
  return (n >= 0) ? n / d : -((-n + d - 1) / d);
}

void setup() {
  Serial.begin(115200);

  pinMode(PIN_CLK, INPUT_PULLUP);
  pinMode(PIN_DT, INPUT_PULLUP);
  pinMode(PIN_SW, INPUT_PULLUP);

  lastAB = (digitalRead(PIN_CLK) << 1) | digitalRead(PIN_DT);
  attachInterrupt(digitalPinToInterrupt(PIN_CLK), encoderISR, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_DT), encoderISR, CHANGE);

  Serial.println(F("READY"));
  Serial.print(F("POS:"));
  Serial.println(lastPosition);
}

void loop() {
  noInterrupts();
  long raw = rawCount;
  interrupts();

  // Offset by half a detent so the rounding boundary sits mid-transition,
  // not at the resting detent where contact bounce happens.
  long position = floorDiv(raw + STEPS_PER_DETENT / 2, STEPS_PER_DETENT);
  if (REVERSE) position = -position;

  if (position != lastPosition) {
    lastPosition = position;
    Serial.print(F("POS:"));
    Serial.println(position);
  }

  bool reading = digitalRead(PIN_SW);
  if (reading != lastButtonReading) {
    lastButtonChange = millis();
    lastButtonReading = reading;
  }
  if ((millis() - lastButtonChange) > DEBOUNCE_MS && reading != buttonState) {
    buttonState = reading;
    if (buttonState == LOW) Serial.println(F("BTN:1"));
    else Serial.println(F("BTN:0"));
  }
}

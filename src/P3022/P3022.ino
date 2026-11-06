const int analogPin = A7; // Define the analog input pin
int rawValue = 0;         // Variable to store the raw 10-bit value (0-1023)
float voltage = 0.0;      // Variable to store the calculated voltage (0-5V)

void setup() {
  // Initialize serial communication at 9600 bits per second
  Serial.begin(9600); 
}

void loop() {
  // Read the analog value (returns 0 to 1023)
  rawValue = analogRead(analogPin);
  
  // Convert the raw reading to an actual voltage value (assuming 5V reference)
  voltage = rawValue * (5.0 / 1023.0);
  
  // Print the raw value to the Serial Monitor
  Serial.print("Raw Value: ");
  Serial.print(rawValue);
  
  // Print the converted voltage value
  Serial.print(" \t Voltage: ");
  Serial.print(voltage);
  Serial.println(" V");
  
  // Wait 50 milliseconds before taking the next reading
  delay(50); 
}

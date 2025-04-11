const express = require('express')
const dotenv = require('dotenv')
const twilio = require('twilio')

// Load environment variables
dotenv.config()

const app = express()
app.use(express.json())

// Store active calls and member information
const activeCalls = new Map()
const members = new Map()
const timers = new Map()

// Default time limit (2 minutes)
const DEFAULT_TIME_LIMIT = 2 * 60 * 1000

// Obfuscate phone number for logging (hide last 5 digits)
function obfuscatePhone(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') return 'unknown'

  // If the phone number is at least 5 characters long, replace last 5 digits
  if (phoneNumber.length >= 5) {
    return phoneNumber.slice(0, -5) + 'xxxxx'
  }

  // For shorter strings, just return "xxxxx"
  return 'xxxxx'
}

// Parse duration string like "30s" or "5m" to milliseconds
function parseDuration(durationStr) {
  if (!durationStr) return DEFAULT_TIME_LIMIT

  const match = durationStr.match(/^(\d+)([sm])$/)
  if (!match) return DEFAULT_TIME_LIMIT

  const value = parseInt(match[1], 10)
  const unit = match[2]

  if (unit === 's') return value * 1000
  if (unit === 'm') return value * 60 * 1000

  return DEFAULT_TIME_LIMIT
}

// Endpoint to receive member information
app.post('/api/member', (req, res) => {
  const { userID, duration, endMessage } = req.body

  if (!userID) {
    return res.status(400).json({ error: 'userID is required' })
  }

  const timeLimit = parseDuration(duration)
  const safeUserID = obfuscatePhone(userID)

  // Store the member information
  members.set(userID, {
    timeLimit,
    endMessage:
      endMessage ||
      'You have reached your time limit. The call will now end. Goodbye.',
  })

  const formattedTime =
    timeLimit >= 60000
      ? `${timeLimit / 60000} minutes`
      : `${timeLimit / 1000} seconds`

  console.log(`Member registered: ${safeUserID}, Time limit: ${formattedTime}`)

  // If there's already an active call, apply the time limit to it
  if (activeCalls.has(userID)) {
    // Start timer for the active call
    const callData = activeCalls.get(userID)
    console.log(
      `Found active call for ${safeUserID}, applying time limit immediately`
    )

    // Clear any existing timer
    if (timers.has(userID)) {
      clearTimeout(timers.get(userID))
      timers.delete(userID)
      console.log(`Cleared previous timer for ${safeUserID}`)
    }

    // Set new timer
    const timer = setTimeout(() => {
      endCall(userID, callData.callSid)
    }, timeLimit)

    // Store timer reference
    timers.set(userID, timer)
    console.log(`Timer set for ${formattedTime} from now`)
  } else {
    console.log(
      `No active call found for ${safeUserID}, time limit will apply when call starts`
    )
  }

  return res.status(200).json({ success: true })
})

// Endpoint to receive call webhooks from Voiceflow
app.post('/api/call-webhook', (req, res) => {
  const event = req.body

  if (event.type === 'runtime.call.start') {
    handleCallStart(event)
  } else if (event.type === 'runtime.call.end') {
    handleCallEnd(event)
  }

  return res.status(200).json({ success: true })
})

// Handle call start event
function handleCallStart(event) {
  const { data } = event
  const { userID, metadata } = data
  const { callSid } = metadata
  const currentTime = Date.now()
  const safeUserID = obfuscatePhone(userID)

  console.log(
    `Call started: ${callSid} from ${safeUserID} at ${new Date(
      currentTime
    ).toISOString()}`
  )

  // Store call information
  activeCalls.set(userID, {
    callSid,
    startTime: currentTime,
    metadata,
  })

  // Check if this user has been registered via /api/member
  if (!members.has(userID)) {
    console.log(`No time limit set for ${safeUserID}, call is not timed`)
    return
  }

  // Get member information and apply the full time limit
  const member = members.get(userID)
  const timeLimit = member.timeLimit

  const formattedTime =
    timeLimit >= 60000
      ? `${timeLimit / 60000} minutes`
      : `${timeLimit / 1000} seconds`

  console.log(
    `Starting timer for user ${safeUserID}, time limit: ${formattedTime}`
  )

  // Set timer for the full time limit
  const timer = setTimeout(() => {
    endCall(userID, callSid)
  }, timeLimit)

  // Store timer reference for cleanup
  timers.set(userID, timer)
}

// Handle call end event
function handleCallEnd(event) {
  const { data } = event
  const { userID, metadata } = data
  const { callSid } = metadata
  const safeUserID = obfuscatePhone(userID)

  console.log(`Call ended: ${callSid} from ${safeUserID}`)

  // Cleanup resources if they exist
  if (timers.has(userID)) {
    clearTimeout(timers.get(userID))
    timers.delete(userID)
    console.log(`Timer cleared for user ${safeUserID}`)
  }

  activeCalls.delete(userID)

  if (members.has(userID)) {
    members.delete(userID)
    console.log(`Member data cleared for user ${safeUserID}`)
  }

  console.log(`Call cleanup completed for user ${safeUserID}`)
}

// End a call using Twilio API
async function endCall(userID, callSid) {
  try {
    const safeUserID = obfuscatePhone(userID)

    // Check if call is still active
    if (!activeCalls.has(userID)) {
      console.log(`Call for ${safeUserID} is no longer active`)
      return
    }

    console.log(`Time limit reached for ${safeUserID}, ending call ${callSid}`)

    // Get member info
    const member = members.get(userID) || {
      endMessage:
        'You have reached your time limit. The call will now end. Goodbye.',
    }

    // Initialize Twilio client with proper credentials
    const accountSid = process.env.TWILIO_ACCOUNT_SID
    const authToken = process.env.TWILIO_AUTH_TOKEN

    console.log('Initialize Twilio client')

    const client = new twilio.Twilio(accountSid, authToken)

    // Send a message with attention notification and custom ending message
    const twiml =
      '<Response>' +
      '<Pause length="2"/>' + // Short pause
      `<Say>${member.endMessage}</Say>` +
      '<Hangup/>' +
      '</Response>'

    console.log(`Sending TwiML: ${twiml}`)
    await client.calls(callSid).update({ twiml })

    console.log(`Successfully ended call ${callSid}`)

    // Clean up resources
    clearTimeout(timers.get(userID))
    timers.delete(userID)
    activeCalls.delete(userID)
    members.delete(userID) // Also clear member data when ending a call
  } catch (error) {
    console.error(`Error ending call: ${error.message}`)
    console.error(error.stack)
  }
}

// Start the server
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

"use client"

import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

interface DateTimePickerProps {
  value?: Date
  onChange?: (date: Date | undefined) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  minDate?: Date
}

export function DateTimePicker({
  value,
  onChange,
  placeholder = "Select date and time",
  className,
  disabled = false,
  minDate,
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false)
  const [date, setDate] = React.useState<Date | undefined>(value)
  const [time, setTime] = React.useState<string>(
    value ? formatTimeForInput(value) : "10:30"
  )

  // Update internal state when value prop changes
  React.useEffect(() => {
    setDate(value)
    if (value) {
      setTime(formatTimeForInput(value))
    }
  }, [value])

  // Helper function to format Date to HH:MM for time input
  function formatTimeForInput(date: Date): string {
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    })
  }

  // Helper function to combine date and time into a single Date object
  function combineDateTime(selectedDate: Date, timeString: string): Date {
    const [hours, minutes] = timeString.split(':').map(Number)
    const combined = new Date(selectedDate)
    combined.setHours(hours, minutes, 0, 0)
    return combined
  }

  const handleDateChange = (newDate: Date | undefined) => {
    setDate(newDate)
    setOpen(false)
    
    if (newDate) {
      // Check if we need to update the time due to minimum time constraints
      let finalTime = time
      
      if (minDate) {
        const today = new Date()
        const isToday = newDate.getFullYear() === today.getFullYear() &&
                       newDate.getMonth() === today.getMonth() &&
                       newDate.getDate() === today.getDate()
        
        if (isToday && minDate > today) {
          const minTime = formatTimeForInput(minDate)
          if (time < minTime) {
            finalTime = minTime
            setTime(minTime)
          }
        }
      }
      
      if (finalTime) {
        const combinedDate = combineDateTime(newDate, finalTime)
        onChange?.(combinedDate)
      }
    } else {
      onChange?.(undefined)
    }
  }

  const handleTimeChange = (newTime: string) => {
    setTime(newTime)
    
    if (date && newTime) {
      const combinedDate = combineDateTime(date, newTime)
      onChange?.(combinedDate)
    }
  }

  // Check if the selected date is today and get minimum time if applicable
  const getMinTime = (): string | undefined => {
    if (!minDate || !date) return undefined
    
    const today = new Date()
    const isToday = date.getFullYear() === today.getFullYear() &&
                   date.getMonth() === today.getMonth() &&
                   date.getDate() === today.getDate()
    
    if (isToday && minDate > today) {
      return formatTimeForInput(minDate)
    }
    
    return undefined
  }

  // Format display value to show in user's local timezone
  const displayDate = date ? date.toLocaleDateString() : "Select date"
  const displayTime = time || "Select time"

  return (
    <div className={cn("flex gap-4", className)}>
      <div className="flex flex-col gap-3">
        <Label htmlFor="date-picker" className="px-1">
          Date
        </Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              id="date-picker"
              className="w-32 justify-between font-normal"
              disabled={disabled}
            >
              {displayDate}
              <ChevronDownIcon className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto overflow-hidden p-0" align="start">
            <Calendar
              mode="single"
              selected={date}
              captionLayout="dropdown"
              onSelect={handleDateChange}
              disabled={(date) => {
                if (minDate) {
                  // Compare only the date part, not the time
                  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate())
                  const minDateOnly = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate())
                  return dateOnly < minDateOnly
                }
                return false
              }}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex flex-col gap-3">
        <Label htmlFor="time-picker" className="px-1">
          Time
        </Label>
        <Input
          type="time"
          id="time-picker"
          value={time}
          onChange={(e) => handleTimeChange(e.target.value)}
          disabled={disabled}
          min={getMinTime()}
          className="bg-background appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
        />
      </div>
    </div>
  )
}

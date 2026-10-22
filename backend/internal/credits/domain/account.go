package domain

type Account struct {
	ID             string
	UserID         string
	DailyQuota     int32
	CurrentBalance int32
}

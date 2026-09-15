package password

import "golang.org/x/crypto/bcrypt"

type Service struct {
	cost int
}

func NewService() Service {
	return Service{cost: bcrypt.DefaultCost}
}

func (s Service) Hash(raw string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(raw), s.cost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func (s Service) Compare(hash string, raw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(raw)) == nil
}
